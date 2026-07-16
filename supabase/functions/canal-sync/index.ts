// ============================================================================
// canal-sync — stock publicado de Mercado Libre por producto (Full vs Flex real)
// ----------------------------------------------------------------------------
// logistic_type NO separa Full/Flex (todo da fulfillment). El split real sale de
//   GET /user-products/{user_product_id}/stock
//     -> locations[]: selling_address = Flex (pool Flexit) ; meli_facility = Full
// Se deduplica por user_product_id (varias publicaciones comparten el mismo).
// Resultado: canal_stock ml_full (meli_facility) + ml_flex (selling_address) por
// SKU, y el depósito FULL = meli_facility. GEN/OFI/FLX no se tocan acá.
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
const API = "https://api.mercadolibre.com";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getToken(d: ReturnType<typeof db>): Promise<{ token: string; seller: string }> {
  const { data: cfg } = await d.from("canal_config").select("*").eq("tipo", "ml").single();
  if (!cfg?.access_token) throw new Error("Mercado Libre no está conectado");
  const exp = cfg.expires_at ? new Date(cfg.expires_at).getTime() : 0;
  if (exp > Date.now() + 60_000) return { token: cfg.access_token, seller: cfg.seller_id };
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token });
  const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" }, body });
  if (!r.ok) throw new Error(`refresh ${r.status}: ${await r.text()}`);
  const j = await r.json();
  await d.from("canal_config").update({ access_token: j.access_token, refresh_token: j.refresh_token ?? cfg.refresh_token, seller_id: String(j.user_id ?? cfg.seller_id), expires_at: new Date(Date.now() + Number(j.expires_in || 21600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("tipo", "ml");
  return { token: j.access_token, seller: String(j.user_id ?? cfg.seller_id) };
}
async function mlGet(path: string, token: string) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`ML ${r.status} ${path}: ${(await r.text()).slice(0, 140)}`);
  return r.json();
}
function skuDe(it: Record<string, any>): string {
  if (it.seller_custom_field) return String(it.seller_custom_field);
  if (it.seller_sku) return String(it.seller_sku);
  const a = ((it.attributes ?? []) as Record<string, any>[]).find((x) => x.id === "SELLER_SKU");
  return a?.value_name ? String(a.value_name) : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  try {
    const { token, seller } = await getToken(d);
    const { data: prods } = await d.from("productos").select("id, sku");
    const bySku = new Map<string, string>();
    for (const p of prods ?? []) bySku.set(String(p.sku).toLowerCase(), p.id);

    // 1) scan de item ids
    const ids: string[] = []; let scroll = "";
    for (let i = 0; i < 80; i++) {
      const data = await mlGet(`/users/${seller}/items/search?search_type=scan&limit=100` + (scroll ? `&scroll_id=${scroll}` : ""), token);
      const res = (data.results ?? []) as string[]; ids.push(...res);
      scroll = data.scroll_id ?? ""; if (!res.length || !scroll) break;
    }

    // 2) multiget -> mapa user_product_id -> sku (dedupe upid)
    const upToSku = new Map<string, string>();
    const sinProducto = new Set<string>();
    for (let i = 0; i < ids.length; i += 20) {
      const arr = await mlGet(`/items?ids=${ids.slice(i, i + 20).join(",")}&attributes=id,status,seller_custom_field,seller_sku,attributes,user_product_id,variations`, token);
      for (const w of arr as Record<string, any>[]) {
        const it = w.body ?? w; if (!it || it.status !== "active") continue;
        const vars = (it.variations ?? []) as Record<string, any>[];
        if (vars.length) {
          for (const v of vars) {
            const up = v.user_product_id ?? it.user_product_id;
            const sku = (v.seller_custom_field ? String(v.seller_custom_field) : skuDe(it)).toLowerCase();
            if (!up) continue;
            if (bySku.has(sku)) upToSku.set(String(up), sku); else if (sku) sinProducto.add(sku);
          }
        } else {
          const up = it.user_product_id; const sku = skuDe(it).toLowerCase();
          if (!up) continue;
          if (bySku.has(sku)) upToSku.set(String(up), sku); else if (sku) sinProducto.add(sku);
        }
      }
    }

    // 3) stock por user_product -> agregado por SKU
    const full = new Map<string, number>(); const flex = new Map<string, number>();
    let upErr = 0;
    for (const [up, sku] of upToSku) {
      try {
        const st = await mlGet(`/user-products/${up}/stock`, token);
        let f = 0, x = 0;
        for (const loc of (st.locations ?? []) as Record<string, any>[]) {
          if (loc.type === "meli_facility") f += Number(loc.quantity ?? 0);
          else if (loc.type === "selling_address") x += Number(loc.quantity ?? 0);
        }
        full.set(sku, (full.get(sku) ?? 0) + f);
        flex.set(sku, (flex.get(sku) ?? 0) + x);
      } catch (_e) { upErr++; }
      await sleep(60);
    }

    // 4) upsert canal_stock (ml_full, ml_flex) + depósito FULL = meli_facility
    await d.from("canal_stock").delete().in("canal", ["ml_full", "ml_flex"]);
    const rows: Record<string, unknown>[] = [];
    const skus = new Set([...full.keys(), ...flex.keys()]);
    for (const sku of skus) {
      const pid = bySku.get(sku); if (!pid) continue;
      const f = full.get(sku) ?? 0, x = flex.get(sku) ?? 0;
      if (f > 0) rows.push({ producto_id: pid, canal: "ml_full", publicado: f, detalle: { fuente: "ml_api" } });
      if (x > 0) rows.push({ producto_id: pid, canal: "ml_flex", publicado: x, detalle: { fuente: "ml_api" } });
    }
    if (rows.length) await d.from("canal_stock").upsert(rows, { onConflict: "producto_id,canal" });

    const { data: depFull } = await d.from("depositos").select("id").eq("codigo", "FULL").single();
    if (depFull) {
      const now = new Date().toISOString();
      for (const [sku, f] of full) {
        const pid = bySku.get(sku); if (!pid) continue;
        await d.from("stock").upsert({ producto_id: pid, deposito_id: depFull.id, cantidad: f, updated_at: now }, { onConflict: "producto_id,deposito_id" });
      }
    }

    const now = new Date().toISOString();
    await d.from("canal_config").update({ meta: { ultima_sync: now, items: ids.length, user_products: upToSku.size, up_err: upErr, sin_producto: [...sinProducto] } }).eq("tipo", "ml");
    return json({ ok: true, items: ids.length, user_products: upToSku.size, filas: rows.length, up_err: upErr, sin_producto: [...sinProducto] });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
