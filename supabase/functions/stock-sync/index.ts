// ============================================================================
// stock-sync — Fase 1 (solo lectura de Contabilium, riesgo cero)
// ----------------------------------------------------------------------------
// Contabilium expone el STOCK TOTAL por producto (campo Stock del "concepto"),
// NO el desglose por depósito (verificado: no hay endpoint de depósitos y el
// parámetro idDeposito se ignora). Por eso el reparto por depósito lo maneja el
// Centro de Stock: esta sync trae el catálogo + el total, respeta lo que la app
// asignó a GEN/FLX/FULL, y deja el remanente en OFI (Oficina = "sin asignar").
//
// Endpoints confirmados:
//   POST /token                                         (client_credentials)
//   GET  /api/conceptos/search?filtro=&pageSize=100&page=N
// ============================================================================
import { preflight, json } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";

const BASE = Deno.env.get("CONTABILIUM_BASE_URL") ?? "https://rest.contabilium.com";
const CID = Deno.env.get("CONTABILIUM_CLIENT_ID") ?? "";
const CS = Deno.env.get("CONTABILIUM_CLIENT_SECRET") ?? "";
const ASIGNABLES = ["GEN", "FLX", "FULL"]; // lo que se asigna explícitamente; OFI = remanente

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let token = "";
async function getToken(): Promise<string> {
  if (token) return token;
  if (!CID || !CS) throw new Error("Faltan CONTABILIUM_CLIENT_ID / CONTABILIUM_CLIENT_SECRET");
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: CID, client_secret: CS });
  const r = await fetch(BASE + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  token = (await r.json()).access_token;
  return token;
}

async function getPage(page: number): Promise<Record<string, unknown>> {
  const tk = await getToken();
  const r = await fetch(`${BASE}/api/conceptos/search?filtro=&pageSize=100&page=${page}`, {
    headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`conceptos ${r.status}: ${await r.text()}`);
  return await r.json();
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  const db = serviceClient();
  try {
    const { data: deps } = await db.from("depositos").select("id, codigo");
    const byCode: Record<string, string> = {};
    for (const dp of deps ?? []) byCode[dp.codigo] = dp.id;
    const ofiId = byCode["OFI"];
    const asignadosIds = ASIGNABLES.map((c) => byCode[c]).filter(Boolean);

    let page = 1, productos = 0, totalPages = 1;
    do {
      const data = await getPage(page);
      totalPages = Number(data.TotalPage ?? 1);
      const items = (data.Items ?? []) as Record<string, unknown>[];
      for (const it of items) {
        if (String(it.Tipo ?? "") !== "Producto") continue;
        const sku = String(it.Codigo ?? "").trim();
        if (!sku) continue;
        const total = Math.round(Number(it.Stock ?? 0));
        const { data: prod } = await db.from("productos").upsert({
          sku,
          nombre: String(it.Nombre ?? ""),
          cb_producto_id: String(it.Id ?? ""),
          costo: Number(it.CostoInterno ?? 0) || null,
          precio: Number(it.PrecioFinal ?? 0) || null,
          stock_minimo: Math.round(Number(it.StockMinimo ?? 0)) || 0,
          activo: String(it.Estado ?? "") === "Activo",
          updated_at: new Date().toISOString(),
        }, { onConflict: "sku" }).select("id").single();
        productos++;
        if (prod && ofiId) {
          const { data: st } = await db.from("stock").select("cantidad, deposito_id").eq("producto_id", prod.id);
          let placed = 0;
          for (const row of st ?? []) if (asignadosIds.includes(row.deposito_id)) placed += Number(row.cantidad);
          await db.from("stock").upsert({
            producto_id: prod.id,
            deposito_id: ofiId,
            cantidad: Math.max(0, total - placed),
            updated_at: new Date().toISOString(),
          }, { onConflict: "producto_id,deposito_id" });
        }
      }
      page++;
      await sleep(350);
    } while (page <= totalPages && page <= 50);

    await db.from("sync_estado").upsert({
      job: "catalogo",
      ultima_ok: new Date().toISOString(),
      detalle: { productos },
      updated_at: new Date().toISOString(),
    });
    return json({ ok: true, productos });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
