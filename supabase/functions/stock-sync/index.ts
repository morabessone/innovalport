// ============================================================================
// stock-sync — CATÁLOGO desde Contabilium (solo lectura, riesgo cero)
// ----------------------------------------------------------------------------
// Mantiene el catálogo de productos (SKU, cb_producto_id, nombre, costo, precio,
// stock_minimo, activo) desde /api/conceptos/search. YA NO reparte stock por
// depósito: eso lo trae deposito-sync desde getStockByDeposito (real por
// depósito), que es la fuente de verdad del stock.
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
    let page = 1, productos = 0, totalPages = 1;
    do {
      const data = await getPage(page);
      totalPages = Number(data.TotalPage ?? 1);
      const items = (data.Items ?? []) as Record<string, unknown>[];
      for (const it of items) {
        if (String(it.Tipo ?? "") !== "Producto") continue;
        const sku = String(it.Codigo ?? "").trim();
        if (!sku) continue;
        await db.from("productos").upsert({
          sku,
          nombre: String(it.Nombre ?? ""),
          cb_producto_id: String(it.Id ?? ""),
          costo: Number(it.CostoInterno ?? 0) || null,
          precio: Number(it.PrecioFinal ?? 0) || null,
          stock_minimo: Math.round(Number(it.StockMinimo ?? 0)) || 0,
          activo: String(it.Estado ?? "") === "Activo",
          updated_at: new Date().toISOString(),
        }, { onConflict: "sku" });
        productos++;
        // NOTA: stock-sync ya NO reparte stock por depósito. El stock por depósito
        // lo trae deposito-sync desde Contabilium (getStockByDeposito, real por
        // depósito). Acá solo se mantiene el CATÁLOGO (SKU, cb_producto_id, costo,
        // precio, mínimo, activo), que deposito-sync/worker necesitan.
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
