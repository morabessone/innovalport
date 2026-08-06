// ============================================================================
// deposito-sync — stock físico por SKU y depósito desde Contabilium (SOLO LECTURA)
// ----------------------------------------------------------------------------
// Fuente: GET /api/inventarios/getStockByDeposito?id={idDep}&pageSize=50&page={n}
//   -> por SKU: Codigo, StockActual, StockReservado, StockConReservas
//   OJO: la paginación es con `page` (NO `pageNo`); pageSize tope ~50.
//
// Escribe SOLO en la tabla `stock` de la app (cantidad + reservado). Nunca
// escribe a Contabilium / ML / TN. Contabilium ya descuenta cada venta y maneja
// combos/cuotas, así que este número es la verdad del depósito.
//
// Depósitos (código -> id Contabilium):
//   GEN=109341(Genpol)  FLX=97439(Flexit)  OFI=127530(Oficina)  FULL=113649
// El FULL puede venir negativo (Contabilium desincronizado): se muestra tal cual,
// a propósito, para que lo corrijan. Lo PUBLICADO en ML lo trae canal-sync.
//
// Credenciales: canal_config (tipo='contabilium'). ?dry=1 no escribe.
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
const CB = "https://rest.contabilium.com";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
type DB = ReturnType<typeof db>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEPOSITOS: { codigo: string; cbId: number }[] = [
  { codigo: "GEN", cbId: 109341 },
  { codigo: "FLX", cbId: 97439 },
  { codigo: "OFI", cbId: 127530 },
  { codigo: "FULL", cbId: 113649 },
];

async function getToken(d: DB): Promise<string> {
  const { data: cfg } = await d.from("canal_config").select("*").eq("tipo", "contabilium").single();
  if (!cfg?.client_id || !cfg?.client_secret) throw new Error("Faltan credenciales de Contabilium en canal_config");
  const exp = cfg.expires_at ? new Date(cfg.expires_at).getTime() : 0;
  if (cfg.access_token && exp > Date.now() + 60_000) return cfg.access_token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.client_id, client_secret: cfg.client_secret });
  const r = await fetch(CB + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`token ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  const ttl = Number(j.expires_in || 3600);
  await d.from("canal_config").update({ access_token: j.access_token, expires_at: new Date(Date.now() + ttl * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("tipo", "contabilium");
  return j.access_token;
}
async function cbGet(path: string, tok: string) {
  const r = await fetch(CB + path, { headers: { Authorization: "Bearer " + tok, Accept: "application/json" } });
  if (!r.ok) throw new Error(`CB ${r.status} ${path}: ${(await r.text()).slice(0, 140)}`);
  return r.json();
}

// Trae TODO el stock de un depósito (paginado con `page`).
async function stockDeposito(cbId: number, tok: string): Promise<{ codigo: string; actual: number; reservado: number }[]> {
  const out: { codigo: string; actual: number; reservado: number }[] = [];
  const vistos = new Set<string>();
  for (let page = 1; page <= 200; page++) {
    const j = await cbGet(`/api/inventarios/getStockByDeposito?id=${cbId}&pageSize=50&page=${page}`, tok);
    const items = j.Items ?? j.items ?? [];
    if (items.length === 0) break;
    let nuevos = 0;
    for (const it of items) {
      const codigo = String(it.Codigo ?? "").trim();
      if (!codigo || vistos.has(codigo)) continue;
      vistos.add(codigo); nuevos++;
      out.push({ codigo, actual: Number(it.StockActual ?? 0), reservado: Number(it.StockReservado ?? 0) });
    }
    if (nuevos === 0) break;           // salvaguarda anti-loop
    if (items.length < 50) break;      // última página
    await sleep(100);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  try {
    const tok = await getToken(d);

    const { data: prods } = await d.from("productos").select("id, sku");
    const bySku = new Map<string, string>();
    for (const p of prods ?? []) if (p.sku) bySku.set(String(p.sku).toLowerCase(), p.id);

    const { data: deps } = await d.from("depositos").select("id, codigo");
    const depUuid = new Map<string, string>();
    for (const x of deps ?? []) depUuid.set(x.codigo, x.id);

    const resumen: Record<string, unknown> = {};
    const now = new Date().toISOString();

    for (const { codigo, cbId } of DEPOSITOS) {
      const depId = depUuid.get(codigo);
      if (!depId) { resumen[codigo] = { error: "depósito no existe en la app" }; continue; }
      const filas = await stockDeposito(cbId, tok);
      let sinMatch = 0, negativos = 0;
      const rows: Record<string, unknown>[] = [];
      for (const f of filas) {
        if (f.actual < 0) negativos++;
        const pid = bySku.get(f.codigo.toLowerCase());
        if (!pid) { sinMatch++; continue; }
        rows.push({ producto_id: pid, deposito_id: depId, cantidad: Math.trunc(f.actual), reservado: Math.trunc(f.reservado), updated_at: now });
      }
      if (!dry) {
        for (let i = 0; i < rows.length; i += 200) {
          const { error } = await d.from("stock").upsert(rows.slice(i, i + 200), { onConflict: "producto_id,deposito_id" });
          if (error) { resumen[codigo + "_err"] = error.message; break; }
        }
      }
      resumen[codigo] = { filas: filas.length, escritas: rows.length, sin_match: sinMatch, negativos };
    }

    return json({ ok: true, dry, resumen });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
