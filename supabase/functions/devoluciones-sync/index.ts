// ============================================================================
// devoluciones-sync — trae las devoluciones de Mercado Libre por API
// ----------------------------------------------------------------------------
// Flujo:
//   1) /post-purchase/v1/claims/search  -> reclamos del vendedor con devolución
//   2) /post-purchase/v1/claims/{id}/returns -> estado del envío de retorno
//   3) /orders/{order_id} -> SKUs reales + cantidades (seller_custom_field)
//
// Mapea a la tabla `devoluciones` (idempotente por ml_claim_id):
//   - retorno en tránsito           -> estado 'en_proceso'
//   - retorno entregado al vendedor -> estado 'por_retirar' (+ entregada_at)
//   - clasifica GEN/FLX según la logística de la orden (fulfillment=Full→GEN).
//
// SEGURIDAD: esta función NO está en cron todavía. Correr con ?dry=1 devuelve
// lo que encontró SIN escribir, para validar el formato real contra un reclamo
// verdadero antes de activarla. Nada se escribe a Contabilium.
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
const API = "https://api.mercadolibre.com";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
type DB = ReturnType<typeof db>;

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

// El estado del envío de retorno nos dice si ya llegó al vendedor.
function estaEntregado(ret: Record<string, any>): boolean {
  const s = String(ret?.status ?? ret?.shipping?.status ?? ret?.status_money ?? "").toLowerCase();
  return ["delivered", "closed", "ready_to_ship_received", "received"].some((k) => s.includes(k));
}

// SKUs + cantidades reales desde la orden asociada al reclamo.
async function skusDeOrden(orderId: string, token: string): Promise<{ sku: string; cantidad: number }[]> {
  try {
    const o = await mlGet(`/orders/${orderId}`, token);
    const out: { sku: string; cantidad: number }[] = [];
    for (const oi of (o.order_items ?? [])) {
      const sku = oi.item?.seller_custom_field ?? oi.item?.seller_sku ?? oi.item?.id ?? null;
      if (sku) out.push({ sku: String(sku), cantidad: Number(oi.quantity ?? 1) });
    }
    // fulfillment = Full (se retira de Genpol), self_service/xd_drop_off = Flex (Flexit)
    const logistic = String(o.shipping?.logistic_type ?? o.shipping?.logistic?.type ?? "");
    return out.map((x) => ({ ...x, logistic } as any));
  } catch { return []; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const dias = Number(url.searchParams.get("dias") ?? 30);
  try {
    const { token, seller } = await getToken(d);
    const desde = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);

    // 1) Reclamos con devolución. El endpoint de búsqueda pagina.
    const search = await mlGet(`/post-purchase/v1/claims/search?limit=50&sort=date_created&range_field=date_created&range_from=${desde}`, token);
    const claims = search.data ?? search.results ?? [];

    const diag: any[] = [];
    let creadas = 0, actualizadas = 0;

    const { data: ofiDeps } = await d.from("depositos").select("id, codigo").in("codigo", ["GEN", "FLX"]);
    const depId = (c: string) => ofiDeps?.find((x) => x.codigo === c)?.id ?? null;

    for (const c of claims) {
      const claimId = String(c.id ?? c.claim_id ?? "");
      if (!claimId) continue;
      let ret: Record<string, any> = {};
      try {
        const rr = await mlGet(`/post-purchase/v1/claims/${claimId}/returns`, token);
        ret = Array.isArray(rr) ? rr[0] ?? {} : rr?.data?.[0] ?? rr ?? {};
      } catch { /* el reclamo puede no tener devolución todavía */ continue; }
      if (!ret || Object.keys(ret).length === 0) continue;

      const orderId = String(c.resource_id ?? c.resource?.id ?? ret.order_id ?? "");
      const items = orderId ? await skusDeOrden(orderId, token) : [];
      const entregado = estaEntregado(ret);
      const logistic = String((items[0] as any)?.logistic ?? "");
      const depCodigo = logistic.includes("fulfillment") ? "GEN" : "FLX";
      const estado = entregado ? "por_retirar" : "en_proceso";

      diag.push({ claimId, orderId, estado, entregado, skus: items.length, depCodigo, ret_status: ret?.status ?? ret?.shipping?.status ?? null });
      if (dry) continue;

      // Idempotente por ml_claim_id.
      const { data: ya } = await d.from("devoluciones").select("id, estado").eq("ml_claim_id", claimId).maybeSingle();
      const totalU = items.reduce((a, i) => a + i.cantidad, 0) || 1;
      const patch: Record<string, unknown> = {
        origen: "ml_api", canal: "ML", ml_claim_id: claimId, ml_return_id: String(ret.id ?? ""),
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
      // Reemplazar ítems (los SKUs que informa ML).
      await d.from("devolucion_items").delete().eq("devolucion_id", devId);
      for (const it of items) {
        const { data: prod } = await d.from("productos").select("id").ilike("sku", it.sku).maybeSingle();
        await d.from("devolucion_items").insert({ devolucion_id: devId, sku: it.sku, producto_id: prod?.id ?? null, cantidad: it.cantidad });
      }
    }

    return json({ ok: true, dry, seller, claims: claims.length, creadas, actualizadas, diag });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
