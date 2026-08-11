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
// Self-contained (sin _shared) para desplegar por MCP.
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
function preflight(req: Request): Response | null { if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders }); return null; }
function serviceClient(): SupabaseClient { const url = Deno.env.get("SUPABASE_URL"); const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); if (!url || !key) throw new Error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }); }

const BASE = Deno.env.get("CONTABILIUM_BASE_URL") ?? "https://rest.contabilium.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Credenciales: SIEMPRE de canal_config (tipo='contabilium'). Contabilium usa
// OAuth2 client_credentials -> client_id = email de la cuenta, client_secret =
// API Key. Fuente única para todas las funciones (igual que deposito-sync).
async function getToken(db: SupabaseClient): Promise<string> {
  const { data: cfg } = await db.from("canal_config").select("*").eq("tipo", "contabilium").single();
  if (!cfg?.client_id || !cfg?.client_secret) throw new Error("Faltan credenciales de Contabilium en canal_config (client_id = email, client_secret = API Key)");
  const exp = cfg.expires_at ? new Date(cfg.expires_at).getTime() : 0;
  if (cfg.access_token && exp > Date.now() + 60_000) return cfg.access_token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.client_id, client_secret: cfg.client_secret });
  const r = await fetch(BASE + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const ttl = Number(j.expires_in || 3600);
  await db.from("canal_config").update({ access_token: j.access_token, expires_at: new Date(Date.now() + ttl * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("tipo", "contabilium");
  return j.access_token;
}

async function getPage(db: SupabaseClient, page: number): Promise<Record<string, unknown>> {
  const tk = await getToken(db);
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
      const data = await getPage(db, page);
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
