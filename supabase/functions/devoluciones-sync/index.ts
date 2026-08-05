// ============================================================================
// devoluciones-sync — trae las devoluciones de Mercado Libre por API (SOLO LECTURA)
// ----------------------------------------------------------------------------
// Se apoya SOLO en endpoints confirmados:
//   /post-purchase/v1/claims/search?status=opened|closed   (reclamos de tipo return)
//   /orders/{id}         -> SKUs reales + logística (fulfillment=Full)
//   /items/{id}          -> fallback para el SKU (seller_custom_field)
//
// Mapeo de estado (sin depender del sub-endpoint /returns):
//   claim status=opened                         -> 'en_proceso'  (en trámite)
//   claim status=closed + resolución item_returned -> 'por_retirar' (volvió, a retirar)
//   depósito de retiro: fulfillment=Full -> GENPOL(GEN) ; resto -> Flexit(FLX)
//
// Escribe SOLO en la base de la app (devoluciones / devolucion_items).
// Nunca escribe a ML / TN / Contabilium. Idempotente por ml_claim_id.
// ?dry=1 no escribe. ?raw=1 vuelca el primer reclamo. ?dias=N ventana (30 def).
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
const API = "https://api.mercadolibre.com";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
type DB = ReturnType<typeof db>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getToken(d: DB): Promise<{ token: string; seller: string }> {
  const { data: cfg } = await d.from("canal_config").select("*").eq("tipo", "ml").single();
  if (!cfg?.access_token) throw new Error("Mercado Libre no está conectado");
  const exp = cfg.expires_at ? new Date(cfg.expires_at).getTime() : 0;
  if (exp > Date.now() + 60_000) return { token: cfg.access_token, seller: cfg.seller_id };
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token });
  const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
  if (!r.ok) throw new Error(`refresh ${r.status}: ${await r.text()}`);
  const j = await r.json();
  await d.from("canal_config").update({ access_token: j.access_token, refresh_token: j.refresh_token ?? cfg.refresh_token, seller_id: String(j.user_id ?? cfg.seller_id), expires_at: new Date(Date.now() + Number(j.expires_in || 21600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("tipo", "ml");
  return { token: j.access_token, seller: String(j.user_id ?? cfg.seller_id) };
}
async function mlGet(path: string, token: string) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const txt = await r.text();
  if (!r.ok) throw new Error(`ML ${r.status} ${path}: ${txt.slice(0, 160)}`);
  try { return JSON.parse(txt); } catch { return {}; }
}

// Trae los reclamos de tipo devolución en un estado dado (paginado).
async function claimsPorEstado(status: string, token: string): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; offset < 200; offset += 50) {
    const s = await mlGet(`/post-purchase/v1/claims/search?status=${status}&limit=50&offset=${offset}`, token);
    const arr = s.data ?? s.results ?? [];
    out.push(...arr.filter((c: any) => String(c.type ?? "").includes("return")));
    if (arr.length < 50) break;
    await sleep(120);
  }
  return out;
}

// Resuelve el SKU real de un order_item (con fallback a /items/{id}).
const itemSkuCache = new Map<string, string | null>();
async function skuDeItem(oi: any, token: string): Promise<string | null> {
  const direct = oi.item?.seller_custom_field ?? oi.item?.seller_sku ?? null;
  if (direct) return String(direct);
  const itemId = oi.item?.id ? String(oi.item.id) : null;
  if (!itemId) return null;
  if (itemSkuCache.has(itemId)) return itemSkuCache.get(itemId)!;
  let sku: string | null = null;
  try {
    const it = await mlGet(`/items/${itemId}?attributes=seller_custom_field,seller_sku,attributes,variations`, token);
    sku = it.seller_custom_field ?? it.seller_sku ?? null;
    if (!sku) {
      const a = (it.attributes ?? []).find((x: any) => x.id === "SELLER_SKU");
      sku = a?.value_name ?? null;
    }
  } catch { /* ignora */ }
  itemSkuCache.set(itemId, sku ? String(sku) : null);
  return sku ? String(sku) : null;
}

// De la orden: SKUs+cantidades y la logística (para clasificar depósito).
async function detalleOrden(orderId: string, token: string) {
  const o = await mlGet(`/orders/${orderId}`, token);
  const items: { sku: string; cantidad: number }[] = [];
  for (const oi of (o.order_items ?? [])) {
    const sku = await skuDeItem(oi, token);
    if (sku) items.push({ sku, cantidad: Number(oi.quantity ?? 1) });
  }
  const logistic = String(o.shipping?.logistic_type ?? "");
  return { items, logistic };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const dias = Number(url.searchParams.get("dias") ?? 30);
  const corte = Date.now() - dias * 864e5;
  try {
    const { token, seller } = await getToken(d);
    const { data: deps } = await d.from("depositos").select("id, codigo").in("codigo", ["GEN", "FLX"]);
    const depId = (c: string) => deps?.find((x) => x.codigo === c)?.id ?? null;

    // opened -> en proceso ; closed con item devuelto -> por retirar
    const abiertos = await claimsPorEstado("opened", token);
    const cerrados = await claimsPorEstado("closed", token);

    type Fila = { claim: any; estado: string };
    const filas: Fila[] = [];
    for (const c of abiertos) {
      if (new Date(c.date_created ?? c.last_updated ?? 0).getTime() < corte) continue;
      filas.push({ claim: c, estado: "en_proceso" });
    }
    for (const c of cerrados) {
      const devuelto = String(c.resolution?.reason ?? "").includes("item_returned") || c.resolution?.reason === "item_returned";
      if (!devuelto) continue;
      if (new Date(c.last_updated ?? c.date_created ?? 0).getTime() < corte) continue;
      filas.push({ claim: c, estado: "por_retirar" });
    }

    if (dry && url.searchParams.get("raw") === "1") {
      return json({ ok: true, dry: true, seller, abiertos: abiertos.length, cerrados: cerrados.length, filas: filas.length, raw_first: filas[0]?.claim ?? null });
    }

    const diag: any[] = [];
    let creadas = 0, actualizadas = 0;
    for (const { claim, estado } of filas) {
      const claimId = String(claim.id ?? "");
      const orderId = String(claim.resource_id ?? claim.resource?.id ?? "");
      let det = { items: [] as { sku: string; cantidad: number }[], logistic: "" };
      if (orderId) { try { det = await detalleOrden(orderId, token); } catch { /* sigue */ } }
      const depCodigo = det.logistic.includes("fulfillment") ? "GEN" : "FLX";

      diag.push({ claimId, orderId, estado, skus: det.items.length, depCodigo });
      if (dry) continue;

      const { data: ya } = await d.from("devoluciones").select("id, estado").eq("ml_claim_id", claimId).maybeSingle();
      const totalU = det.items.reduce((a, i) => a + i.cantidad, 0) || 1;
      const entregado = estado === "por_retirar";
      const patch: Record<string, unknown> = {
        origen: "ml_api", canal: "ML", ml_claim_id: claimId,
        venta_ref: orderId || null, cantidad: totalU, estado,
        deposito_retiro_id: entregado ? depId(depCodigo) : null,
        entregada_at: entregado ? new Date().toISOString() : null,
      };
      let devId: string;
      if (ya) {
        // No pisar una devolución que ya avanzó a oficina/resuelta.
        if (["en_oficina", "apta", "no_apta", "parcial"].includes(ya.estado)) continue;
        await d.from("devoluciones").update(patch).eq("id", ya.id);
        devId = ya.id; actualizadas++;
      } else {
        const { data: nuevo, error } = await d.from("devoluciones").insert(patch).select("id").single();
        if (error) { diag.push({ claimId, error: error.message }); continue; }
        devId = nuevo.id; creadas++;
      }
      await d.from("devolucion_items").delete().eq("devolucion_id", devId);
      for (const it of det.items) {
        const { data: prod } = await d.from("productos").select("id").ilike("sku", it.sku).maybeSingle();
        await d.from("devolucion_items").insert({ devolucion_id: devId, sku: it.sku, producto_id: prod?.id ?? null, cantidad: it.cantidad });
      }
    }
    return json({ ok: true, dry, seller, abiertos: abiertos.length, cerrados: cerrados.length, creadas, actualizadas, diag });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
