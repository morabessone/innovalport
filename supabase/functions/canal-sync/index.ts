// ============================================================================
// canal-sync — trae el stock PUBLICADO de Mercado Libre por publicación
// ----------------------------------------------------------------------------
// Usa el token guardado en canal_config (tipo='ml'), refrescándolo si venció.
// Recorre las publicaciones del vendedor, lee available_quantity y el tipo de
// logística (fulfillment = Full, resto = Flex/propio), matchea por SKU y llena
// canal_stock con el publicado por producto y canal (ml_full / ml_flex).
// TN y Web comparten el pool de Flex, así que se representan con ml_flex.
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
const API = "https://api.mercadolibre.com";

async function getToken(d: ReturnType<typeof db>): Promise<{ token: string; seller: string }> {
  const { data: cfg } = await d.from("canal_config").select("*").eq("tipo", "ml").single();
  if (!cfg?.access_token) throw new Error("Mercado Libre no está conectado (falta autorizar)");
  const exp = cfg.expires_at ? new Date(cfg.expires_at).getTime() : 0;
  if (exp > Date.now() + 60_000) return { token: cfg.access_token, seller: cfg.seller_id };
  // refrescar
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token });
  const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" }, body });
  if (!r.ok) throw new Error(`refresh ${r.status}: ${await r.text()}`);
  const j = await r.json();
  await d.from("canal_config").update({
    access_token: j.access_token, refresh_token: j.refresh_token ?? cfg.refresh_token,
    seller_id: String(j.user_id ?? cfg.seller_id),
    expires_at: new Date(Date.now() + Number(j.expires_in || 21600) * 1000).toISOString(), updated_at: new Date().toISOString(),
  }).eq("tipo", "ml");
  return { token: j.access_token, seller: String(j.user_id ?? cfg.seller_id) };
}

async function mlGet(path: string, token: string) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`ML ${r.status} ${path}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

function skuDeItem(it: Record<string, any>): string {
  if (it.seller_custom_field) return String(it.seller_custom_field);
  if (it.seller_sku) return String(it.seller_sku);
  const attrs = (it.attributes ?? []) as Record<string, any>[];
  const a = attrs.find((x) => x.id === "SELLER_SKU");
  if (a?.value_name) return String(a.value_name);
  return "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  try {
    const { token, seller } = await getToken(d);

    // mapa sku -> producto_id
    const { data: prods } = await d.from("productos").select("id, sku");
    const bySku = new Map<string, string>();
    for (const p of prods ?? []) bySku.set(String(p.sku).toLowerCase(), p.id);

    // 1) IDs de publicaciones del vendedor (scan)
    const ids: string[] = [];
    let scroll = "";
    for (let i = 0; i < 60; i++) {
      const q = `/users/${seller}/items/search?search_type=scan&limit=100` + (scroll ? `&scroll_id=${scroll}` : "");
      const data = await mlGet(q, token);
      const res = (data.results ?? []) as string[];
      ids.push(...res);
      scroll = data.scroll_id ?? "";
      if (!res.length || !scroll) break;
    }

    // 2) multiget en lotes de 20 -> agregado por (producto, canal)
    const agg = new Map<string, { producto_id: string; canal: string; qty: number; ref: string }>();
    let matched = 0;
    const sinProducto = new Set<string>(); // SKUs publicados que no existen en el catálogo
    for (let i = 0; i < ids.length; i += 20) {
      const lote = ids.slice(i, i + 20).join(",");
      const arr = await mlGet(`/items?ids=${lote}&attributes=id,status,available_quantity,seller_custom_field,seller_sku,attributes,shipping,variations`, token);
      for (const w of arr as Record<string, any>[]) {
        const it = w.body ?? w;
        if (!it || it.status !== "active") continue;
        const sku = skuDeItem(it).toLowerCase();
        const pid = bySku.get(sku);
        if (!pid) { if (sku) sinProducto.add(sku); continue; }
        const canal = it?.shipping?.logistic_type === "fulfillment" ? "ml_full" : "ml_flex";
        let qty = Number(it.available_quantity ?? 0);
        if (Array.isArray(it.variations) && it.variations.length) {
          qty = it.variations.reduce((a: number, v: Record<string, any>) => a + Number(v.available_quantity ?? 0), 0);
        }
        // Varias publicaciones del MISMO SKU comparten un único pool: ML muestra
        // el mismo available_quantity en cada una. Por eso NO se suman entre sí,
        // se toma el máximo (dedupe). Sumarlas multiplicaba el stock publicado.
        const key = pid + "|" + canal;
        const prev = agg.get(key);
        if (prev) { if (qty > prev.qty) { prev.qty = qty; prev.ref = it.id; } }
        else agg.set(key, { producto_id: pid, canal, qty, ref: it.id });
        matched++;
      }
    }

    // 3) reset del publicado de ML y upsert
    await d.from("canal_stock").delete().in("canal", ["ml_full", "ml_flex"]);
    const rows = [...agg.values()].map((v) => ({ producto_id: v.producto_id, canal: v.canal, publicado: v.qty, listing_ref: v.ref, updated_at: new Date().toISOString() }));
    if (rows.length) await d.from("canal_stock").upsert(rows, { onConflict: "producto_id,canal" });

    // Full físico = publicado en Full (ML administra ese depósito). Se refleja el
    // valor en el depósito FULL y se rebalancea contra OFI manteniendo el total.
    const { data: deps } = await d.from("depositos").select("id, codigo");
    const depBy: Record<string, string> = {};
    for (const x of deps ?? []) depBy[x.codigo] = x.id;
    const now = new Date().toISOString();
    for (const v of agg.values()) {
      if (v.canal !== "ml_full" || !depBy.FULL || !depBy.OFI) continue;
      const { data: st } = await d.from("stock").select("deposito_id, cantidad").eq("producto_id", v.producto_id);
      const cur: Record<string, number> = {};
      for (const r of st ?? []) cur[r.deposito_id] = Number(r.cantidad);
      const total = Object.values(cur).reduce((a, b) => a + b, 0);
      const otros = (cur[depBy.FLX] ?? 0) + (cur[depBy.GEN] ?? 0);
      await d.from("stock").upsert({ producto_id: v.producto_id, deposito_id: depBy.FULL, cantidad: v.qty, updated_at: now }, { onConflict: "producto_id,deposito_id" });
      await d.from("stock").upsert({ producto_id: v.producto_id, deposito_id: depBy.OFI, cantidad: Math.max(0, total - v.qty - otros), updated_at: now }, { onConflict: "producto_id,deposito_id" });
    }

    const sinProd = [...sinProducto];
    await d.from("canal_config").update({ meta: { ultima_sync: now, items: ids.length, publicaciones_matcheadas: matched, sin_producto: sinProd } }).eq("tipo", "ml");
    return json({ ok: true, items: ids.length, matcheadas: matched, filas: rows.length, sin_producto: sinProd });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
