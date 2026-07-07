// ============================================================================
// stock-sync — Fase 1 (solo lectura, riesgo cero)
// ----------------------------------------------------------------------------
// Trae el catálogo y el stock desde Contabilium hacia el espejo (productos /
// stock). NO escribe nada en Contabilium.
//
// Endpoints CONFIRMADOS contra la API real (rest.contabilium.com):
//   * Auth:      POST /token  (client_credentials: email + API Key)
//   * Productos: GET  /api/conceptos/search?filtro=&pageSize=100&page=N
//                -> { Items:[{ Id, Codigo(SKU), Nombre, CostoInterno,
//                     PrecioFinal, Stock, StockMinimo, Estado, Tipo }], TotalPage }
// La API expone el STOCK TOTAL por producto (campo Stock), no el desglose por
// depósito, así que el total se carga en Genpol (el depósito general). Cuando se
// confirme un endpoint de stock por depósito, se reemplaza acá.
// ============================================================================
import { preflight, json } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";

const BASE = Deno.env.get("CONTABILIUM_BASE_URL") ?? "https://rest.contabilium.com";
const CID = Deno.env.get("CONTABILIUM_CLIENT_ID") ?? "";
const CS = Deno.env.get("CONTABILIUM_CLIENT_SECRET") ?? "";
const DEP_GENERAL = "GEN"; // Genpol = depósito general donde se refleja el stock total

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
    const { data: dep } = await db.from("depositos").select("id").eq("codigo", DEP_GENERAL).single();
    const depId = dep?.id as string | undefined;

    let page = 1, productos = 0, stockRows = 0, totalPages = 1;
    do {
      const data = await getPage(page);
      totalPages = Number(data.TotalPage ?? 1);
      const items = (data.Items ?? []) as Record<string, unknown>[];
      for (const it of items) {
        if (String(it.Tipo ?? "") !== "Producto") continue;
        const sku = String(it.Codigo ?? "").trim();
        if (!sku) continue;
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
        if (prod && depId) {
          await db.from("stock").upsert({
            producto_id: prod.id,
            deposito_id: depId,
            cantidad: Math.round(Number(it.Stock ?? 0)),
            updated_at: new Date().toISOString(),
          }, { onConflict: "producto_id,deposito_id" });
          stockRows++;
        }
      }
      page++;
      await sleep(400);
    } while (page <= totalPages && page <= 50);

    await db.from("sync_estado").upsert({
      job: "catalogo",
      ultima_ok: new Date().toISOString(),
      detalle: { productos, stock: stockRows },
      updated_at: new Date().toISOString(),
    });
    return json({ ok: true, productos, stock: stockRows });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
