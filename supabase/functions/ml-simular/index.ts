// ============================================================================
// ml-simular — replica el simulador de costos de Mercado Libre (SOLO lectura).
// ----------------------------------------------------------------------------
//   accion "buscar"  { q }                 -> categorías (domain_discovery) +
//                                             publicaciones del vendedor.
//   accion "costos"  { category_id, price, listing_type_id? }
//                     -> /sites/MLA/listing_prices: cargo por vender REAL
//                        (percentage_fee + fixed_fee) por tipo de publicación.
//   accion "item"    { item_id }           -> datos de la publicación + costos.
// Credenciales de canal_config. Nunca escribe en ML.
// ============================================================================
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
const API = "https://api.mercadolibre.com";
const SITE = "MLA";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
type DB = SupabaseClient;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function ml(d: DB): Promise<{ token: string | null; seller: string | null }> {
  const { data: cfg } = await d.from("canal_config").select("*").eq("tipo", "ml").maybeSingle();
  if (!cfg) return { token: null, seller: null };
  const seller = cfg.seller_id ? String(cfg.seller_id) : null;
  const exp = cfg.expires_at ? new Date(cfg.expires_at).getTime() : 0;
  if (cfg.access_token && exp > Date.now() + 60_000) return { token: cfg.access_token, seller };
  try {
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token });
    const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    if (!r.ok) return { token: null, seller };
    const j = await r.json();
    await d.from("canal_config").update({ access_token: j.access_token, refresh_token: j.refresh_token ?? cfg.refresh_token, expires_at: new Date(Date.now() + Number(j.expires_in || 21600) * 1000).toISOString() }).eq("tipo", "ml");
    return { token: j.access_token, seller };
  } catch { return { token: null, seller }; }
}
async function get(path: string, token: string): Promise<any | null> {
  try { const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }); if (!r.ok) return null; return await r.json(); } catch { return null; }
}
// Extrae % y costo fijo del cargo por vender de /sites/MLA/listing_prices.
function feeDe(obj: any, price: number) {
  const det = obj?.sale_fee_details ?? {};
  const fee = num(obj?.sale_fee_amount);
  const fixed = num(det.fixed_fee);
  // percentage_fee viene en % (ej 16.5). Si no está, lo derivamos.
  let pct = num(det.percentage_fee);
  if (!pct && price > 0) pct = ((fee - fixed) / price) * 100;
  return { sale_fee_amount: Math.round(fee), percentage_fee: Number(pct.toFixed(2)), fixed_fee: Math.round(fixed), listing_type_id: obj?.listing_type_id ?? null, listing_type_name: obj?.listing_type_name ?? null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const accion = body.accion ?? "buscar";
  try {
    const { token, seller } = await ml(d);
    if (!token) return json({ ok: false, error: "Mercado Libre no está conectado" }, 400);

    if (accion === "buscar") {
      const q = String(body.q ?? "").trim();
      if (!q) return json({ ok: true, categorias: [], publicaciones: [] });
      // Categorías predichas.
      const dom = await get(`/sites/${SITE}/domain_discovery/search?limit=8&q=${encodeURIComponent(q)}`, token);
      const categorias = (Array.isArray(dom) ? dom : []).map((x: any) => ({ category_id: x.category_id, category_name: x.category_name, domain_name: x.domain_name })).filter((x: any) => x.category_id);
      // Publicaciones del vendedor que matchean.
      let publicaciones: any[] = [];
      if (seller) {
        const s = await get(`/users/${seller}/items/search?q=${encodeURIComponent(q)}&limit=8`, token);
        const ids = (s?.results ?? []) as string[];
        if (ids.length) {
          const items = await get(`/items?ids=${ids.slice(0, 12).join(",")}&attributes=id,title,price,category_id,listing_type_id,thumbnail,seller_custom_field`, token);
          publicaciones = (Array.isArray(items) ? items : []).map((w: any) => w.body).filter(Boolean).map((it: any) => ({
            id: it.id, title: it.title, price: num(it.price), category_id: it.category_id,
            listing_type_id: it.listing_type_id, thumbnail: it.thumbnail, sku: it.seller_custom_field ?? null,
          }));
        }
      }
      return json({ ok: true, categorias, publicaciones });
    }

    if (accion === "costos") {
      const category_id = String(body.category_id ?? "");
      const price = num(body.price);
      const lt = body.listing_type_id ? String(body.listing_type_id) : "";
      if (!category_id || !price) return json({ ok: false, error: "faltan category_id o price" }, 400);
      const j = await get(`/sites/${SITE}/listing_prices?price=${price}&category_id=${encodeURIComponent(category_id)}${lt ? `&listing_type_id=${encodeURIComponent(lt)}` : ""}`, token);
      const arr = Array.isArray(j) ? j : (j ? [j] : []);
      const opciones = arr.map((o) => feeDe(o, price));
      const elegido = lt ? (opciones.find((o) => o.listing_type_id === lt) ?? opciones[0]) : (opciones.find((o) => o.listing_type_id === "gold_special") ?? opciones[0]);
      return json({ ok: true, opciones, elegido: elegido ?? null });
    }

    if (accion === "item") {
      const item_id = String(body.item_id ?? "");
      if (!item_id) return json({ ok: false, error: "falta item_id" }, 400);
      const it = await get(`/items/${item_id}?attributes=id,title,price,category_id,listing_type_id,thumbnail,seller_custom_field`, token);
      if (!it?.id) return json({ ok: false, error: "publicación no encontrada" }, 404);
      const price = num(it.price);
      const j = await get(`/sites/${SITE}/listing_prices?price=${price}&category_id=${encodeURIComponent(it.category_id)}&listing_type_id=${encodeURIComponent(it.listing_type_id)}`, token);
      const arr = Array.isArray(j) ? j : (j ? [j] : []);
      const costos = feeDe(arr.find((o: any) => o.listing_type_id === it.listing_type_id) ?? arr[0] ?? {}, price);
      return json({ ok: true, item: { id: it.id, title: it.title, price, category_id: it.category_id, listing_type_id: it.listing_type_id, thumbnail: it.thumbnail, sku: it.seller_custom_field ?? null }, costos });
    }

    return json({ ok: false, error: "acción desconocida" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
