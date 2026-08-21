// ============================================================================
// ml-ads-sync — inversión de Mercado Ads (Product Ads) por publicación (lectura)
// ----------------------------------------------------------------------------
// Resuelve el advertiser de Product Ads y trae, por publicación, la inversión y
// métricas del período (cost, clicks, prints, acos, roas, unidades y venta
// atribuidas). Se usa para imputar el costo de publicidad por SKU en Finanzas.
// Nunca escribe en ML. Credenciales de canal_config. Parámetro: ?dias=N (def 30).
// Doc: la API de métricas admite hasta 90 días de ventana.
// ============================================================================
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
const API = "https://api.mercadolibre.com";
const SITE = "MLA";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
type DB = SupabaseClient;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const low = (s: unknown) => String(s ?? "").trim().toLowerCase();
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

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
async function mlGet(path: string, token: string, apiVersion?: string): Promise<any | null> {
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };
    if (apiVersion) { headers["Api-Version"] = apiVersion; headers["api-version"] = apiVersion; }
    const r = await fetch(API + path, { headers });
    if (!r.ok) return { __status: r.status };
    return await r.json();
  } catch { return null; }
}
// Lee una métrica esté en el nivel superior o bajo metrics/metrics_summary.
function metric(r: any, k: string): number {
  return num(r?.[k] ?? r?.metrics?.[k] ?? r?.metrics_summary?.[k]);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  const url = new URL(req.url);
  const dias = Math.min(90, Number(url.searchParams.get("dias") ?? 30) || 30);
  try {
    const token = await mlToken(d);
    if (!token) return json({ ok: false, error: "Mercado Libre no está conectado" }, 400);

    const adv = await mlGet(`/advertising/advertisers?product_id=PADS`, token, "1");
    const advertiser = (adv?.advertisers ?? []).find((a: any) => low(a.site_id) === low(SITE)) ?? (adv?.advertisers ?? [])[0];
    if (!advertiser?.advertiser_id) return json({ ok: false, error: "Sin advertiser de Product Ads (¿publicidad habilitada?)", detalle: adv }, 400);
    const advId = advertiser.advertiser_id;

    const df = ymd(new Date(Date.now() - dias * 86400_000));
    const dt = ymd(new Date());
    const metrics = "cost,clicks,prints,acos,roas,advertising_items_quantity,units_quantity,total_amount";

    // Mapa de respaldo ml_item_id -> sku.
    const { data: pubs } = await d.from("publicaciones").select("ml_item_id, sku");
    const skuByItem = new Map<string, string>();
    for (const p of (pubs ?? []) as any[]) if (p.ml_item_id && p.sku) skuByItem.set(String(p.ml_item_id), String(p.sku));

    const rows: Record<string, any>[] = [];
    let vistos = 0;
    for (let offset = 0; offset < 3000; offset += 50) {
      const data = await mlGet(`/advertising/${SITE}/advertisers/${advId}/product_ads/ads/search?limit=50&offset=${offset}&date_from=${df}&date_to=${dt}&metrics=${metrics}`, token, "2");
      const results = (data?.results ?? []) as any[];
      if (!results.length) break;
      for (const r of results) {
        const itemId = String(r.item_id ?? r.id ?? "");
        if (!itemId) continue;
        vistos++;
        rows.push({
          ml_item_id: itemId, periodo_dias: dias,
          sku: skuByItem.get(itemId) ? low(skuByItem.get(itemId)) : null,
          cost: Math.round(metric(r, "cost")), clicks: metric(r, "clicks"), prints: metric(r, "prints"),
          acos: metric(r, "acos") || null, roas: metric(r, "roas") || null,
          units: metric(r, "advertising_items_quantity") || metric(r, "units_quantity"),
          amount: Math.round(metric(r, "total_amount")),
          updated_at: new Date().toISOString(),
        });
      }
      if (results.length < 50) break;
      await sleep(120);
    }

    let guardadas = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await d.from("ml_ads").upsert(chunk, { onConflict: "ml_item_id,periodo_dias" });
      if (error) return json({ ok: false, error: error.message, guardadas }, 500);
      guardadas += chunk.length;
    }
    const inv = rows.reduce((s, r) => s + Number(r.cost || 0), 0);
    return json({ ok: true, advertiser_id: advId, periodo_dias: dias, anuncios: vistos, filas: guardadas, inversion_total: inv });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
