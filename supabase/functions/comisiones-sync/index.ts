// ============================================================================
// comisiones-sync — comisión REAL de Mercado Libre por publicación (lectura)
// ----------------------------------------------------------------------------
// Por cada publicación activa consulta el costo de venta real que cobra ML para
// su precio + categoría + tipo de publicación:
//   GET /sites/MLA/listing_prices?price={p}&listing_type_id={lt}&category_id={cat}
//     -> sale_fee_amount (comisión en $, incluye el cargo fijo por venta)
// Guarda comision_monto y comision_pct en la tabla publicaciones. Nunca escribe
// en ML. Se usa para el cálculo financiero preciso.
// ============================================================================
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
const API = "https://api.mercadolibre.com";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
type DB = ReturnType<typeof db>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mlToken(d: DB): Promise<string | null> {
  const { data: cfg } = await d.from("canal_config").select("*").eq("tipo", "ml").maybeSingle();
  if (!cfg?.access_token) return null;
  const exp = cfg.expires_at ? new Date(cfg.expires_at).getTime() : 0;
  if (exp > Date.now() + 60_000) return cfg.access_token;
  try {
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token });
    const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    if (!r.ok) return null;
    const j = await r.json();
    await d.from("canal_config").update({ access_token: j.access_token, refresh_token: j.refresh_token ?? cfg.refresh_token, expires_at: new Date(Date.now() + Number(j.expires_in || 21600) * 1000).toISOString() }).eq("tipo", "ml");
    return j.access_token;
  } catch { return null; }
}
async function mlTry(path: string, token: string): Promise<any | null> {
  try {
    const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  const url = new URL(req.url);
  const soloActivas = url.searchParams.get("todas") !== "1";
  try {
    const tok = await mlToken(d);
    if (!tok) return json({ ok: false, error: "Mercado Libre no está conectado" }, 400);

    let q = d.from("publicaciones").select("ml_item_id, precio, categoria_id, listing_type_id, comision_pct").not("categoria_id", "is", null);
    if (soloActivas) q = q.eq("activa_real", true);
    const { data: pubs } = await q.limit(500);

    let hechas = 0, sinDato = 0;
    for (const p of (pubs ?? []) as any[]) {
      const precio = Number(p.precio || 0);
      if (!precio || !p.categoria_id) continue;
      const lt = p.listing_type_id || "gold_special";
      const j = await mlTry(`/sites/MLA/listing_prices?price=${precio}&listing_type_id=${encodeURIComponent(lt)}&category_id=${encodeURIComponent(p.categoria_id)}`, tok);
      // El endpoint devuelve un objeto (o array); tomamos sale_fee_amount.
      const obj = Array.isArray(j) ? (j.find((x) => x.listing_type_id === lt) ?? j[0]) : j;
      const fee = Number(obj?.sale_fee_amount ?? 0);
      if (fee > 0) {
        await d.from("publicaciones").update({ comision_monto: Math.round(fee), comision_pct: Number((fee / precio).toFixed(4)) }).eq("ml_item_id", p.ml_item_id);
        hechas++;
      } else sinDato++;
      await sleep(80);
    }
    return json({ ok: true, comisiones: hechas, sin_dato: sinDato });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
