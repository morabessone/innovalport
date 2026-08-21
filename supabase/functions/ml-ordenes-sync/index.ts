// ============================================================================
// ml-ordenes-sync — órdenes de Mercado Libre a nivel venta (SOLO lectura).
// ----------------------------------------------------------------------------
// Por cada orden del período trae, por publicación:
//   · monto cobrado + comisión real (order_items[].sale_fee),
//   · estado del pago y money_release_date de Mercado Pago
//     -> acreditado (ya disponible) vs. pendiente de acreditar,
//   · costo real de logística al vendedor (GET /shipments/{id}/costs).
// Guarda en ml_ordenes. Nunca escribe en ML. Credenciales de canal_config.
// Re-ejecutable: ?dias=N (ventana), ?max=N (tope de órdenes), ?rebuild=1.
// ============================================================================
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
const API = "https://api.mercadolibre.com";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
type DB = SupabaseClient;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const low = (s: unknown) => String(s ?? "").trim().toLowerCase();

async function mlToken(d: DB): Promise<{ token: string | null; seller: string | null }> {
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
async function mlGet(path: string, token: string): Promise<any | null> {
  try {
    const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
// La API de pagos vive en api.mercadopago.com (NO en api.mercadolibre.com). El
// mismo token de ML del vendedor tiene acceso a sus propios pagos ahí.
async function mpGet(path: string, token: string): Promise<any | null> {
  try {
    const r = await fetch("https://api.mercadopago.com" + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) return { __status: r.status };
    return await r.json();
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  const url = new URL(req.url);
  const dias = Number(url.searchParams.get("dias") ?? 30) || 30;
  const max = Number(url.searchParams.get("max") ?? 120) || 120;
  const rebuild = url.searchParams.get("rebuild") === "1";
  try {
    const { token, seller } = await mlToken(d);
    if (!token) return json({ ok: false, error: "Mercado Libre no está conectado" }, 400);
    if (!seller) return json({ ok: false, error: "Falta seller_id en canal_config (tipo=ml)" }, 400);

    // Mapa de respaldo ml_item_id -> sku (por si el ítem no trae seller_sku).
    const { data: pubs } = await d.from("publicaciones").select("ml_item_id, sku, logistic_type");
    const skuByItem = new Map<string, string>();
    const logByItem = new Map<string, string>();
    for (const p of (pubs ?? []) as any[]) {
      if (p.ml_item_id) { if (p.sku) skuByItem.set(String(p.ml_item_id), String(p.sku)); if (p.logistic_type) logByItem.set(String(p.ml_item_id), String(p.logistic_type)); }
    }

    // Qué órdenes ya tienen envío / acreditación resueltos (para no re-pedir).
    const { data: yaRows } = await d.from("ml_ordenes").select("order_id, envio_costo, acreditado");
    const envioResuelto = new Set<number>();
    const acredResuelto = new Set<number>();
    for (const r of (yaRows ?? []) as any[]) {
      if (Number(r.envio_costo) > 0) envioResuelto.add(Number(r.order_id));
      if (r.acreditado) acredResuelto.add(Number(r.order_id));
    }

    const desde = new Date(Date.now() - dias * 86400_000).toISOString();
    const hasta = new Date(Date.now() + 86400_000).toISOString();
    const rows: Record<string, any>[] = [];
    let vistas = 0, envioCalls = 0, mpCalls = 0, mpOk = 0;
    const maxEnvio = 70;   // tope de lookups de shipment por corrida (se completan de a poco)
    // Acreditación real desde Mercado Pago (api.mercadopago.com/v1/payments). El
    // token de ML del vendedor tiene acceso. Activado por defecto; ?mp=0 lo apaga.
    const maxMp = url.searchParams.get("mp") === "0" ? 0 : 150;

    paging:
    for (let offset = 0; offset < 2000; offset += 50) {
      const data = await mlGet(`/orders/search?seller=${seller}&order.date_created.from=${encodeURIComponent(desde)}&order.date_created.to=${encodeURIComponent(hasta)}&sort=date_desc&offset=${offset}&limit=50`, token);
      const results = (data?.results ?? []) as any[];
      if (!results.length) break;
      for (const o of results) {
        if (vistas >= max) break paging;
        vistas++;
        const orderId = Number(o.id);
        const fecha = o.date_created ?? null;
        // Pago: tomamos el aprobado (o el primero) y su money_release_date.
        const pagos = (o.payments ?? []) as any[];
        const pago = pagos.find((p) => low(p.status) === "approved") ?? pagos[0] ?? {};
        const estado = String(pago.status ?? o.status ?? "");
        const paymentId = Number(pago.id ?? 0) || null;
        // La acreditación (money_release_date) no viene en la orden: se consulta
        // a la API de pagos de Mercado Pago /v1/payments/{id}. Solo para pagos
        // aprobados y no resueltos aún, con tope por corrida.
        let releaseDate = pago.money_release_date ?? null;
        let releaseStatus: string | null = pago.money_release_status ?? null;
        let netoRecibido: number | null = null;
        if (paymentId && low(estado) === "approved" && !acredResuelto.has(orderId) && mpCalls < maxMp) {
          mpCalls++;
          const pay = await mpGet(`/v1/payments/${paymentId}`, token);
          if (pay && !pay.__status) {
            mpOk++;
            releaseDate = pay.money_release_date ?? releaseDate;
            releaseStatus = pay.money_release_status ?? releaseStatus;
            const net = pay.transaction_details?.net_received_amount;
            if (net != null) netoRecibido = Number(net);
          }
          await sleep(40);
        }
        const acreditado = low(String(releaseStatus ?? "")) === "released"
          || (!!releaseDate && new Date(releaseDate).getTime() <= Date.now());

        // Logística real al vendedor (una llamada por orden, con tope).
        let envioOrden = 0;
        const shipId = Number(o.shipping?.id ?? 0) || null;
        if (shipId && !envioResuelto.has(orderId) && (rebuild || true) && envioCalls < maxEnvio) {
          envioCalls++;
          const costs = await mlGet(`/shipments/${shipId}/costs`, token);
          if (costs) {
            const senders = (costs.senders ?? []) as any[];
            const sc = senders.reduce((s, x) => s + (Number(x.cost ?? 0) || 0), 0);
            envioOrden = sc > 0 ? sc : Math.max(0, Number(costs.gross_amount ?? 0) - Number(costs.receiver?.cost ?? 0));
          }
          if (!envioOrden) { const sh = await mlGet(`/shipments/${shipId}`, token); envioOrden = Number(sh?.shipping_option?.list_cost ?? sh?.shipping_option?.cost ?? 0) || 0; }
          await sleep(60);
        }

        const items = (o.order_items ?? []) as any[];
        const brutoOrden = items.reduce((s, it) => s + Number(it.unit_price ?? 0) * Number(it.quantity ?? 0), 0) || 1;
        for (const it of items) {
          const itemId = String(it.item?.id ?? "");
          if (!itemId) continue;
          const sku = it.item?.seller_sku || it.item?.seller_custom_field || skuByItem.get(itemId) || null;
          const cant = Number(it.quantity ?? 0);
          const monto = Number(it.unit_price ?? 0) * cant;
          const saleFee = Number(it.sale_fee ?? 0) * cant;   // sale_fee es por unidad
          const share = brutoOrden > 0 ? monto / brutoOrden : 1;
          const envio = envioOrden * share;                  // proporcional al ítem
          rows.push({
            order_id: orderId, ml_item_id: itemId, sku: sku ? low(sku) : null, fecha,
            cantidad: cant, monto: Math.round(monto), sale_fee: Math.round(saleFee),
            envio_costo: Math.round(envio),
            logistic_type: it.item?.logistic_type ?? logByItem.get(itemId) ?? o.shipping?.logistic_type ?? null,
            pago_estado: estado, payment_id: paymentId, money_release_status: releaseStatus,
            acreditado, fecha_acreditacion: releaseDate,
            neto_recibido: netoRecibido != null ? Math.round(netoRecibido * share) : null,
            shipment_id: shipId,
            updated_at: new Date().toISOString(),
          });
        }
      }
      if (results.length < 50) break;
    }

    // Upsert en lotes.
    let guardadas = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await d.from("ml_ordenes").upsert(chunk, { onConflict: "order_id,ml_item_id" });
      if (error) return json({ ok: false, error: error.message, guardadas }, 500);
      guardadas += chunk.length;
    }

    const acred = rows.filter((r) => r.acreditado).length;
    return json({ ok: true, ordenes_vistas: vistas, filas: guardadas, acreditadas: acred, pendientes: rows.length - acred, envio_lookups: envioCalls, pago_lookups: mpCalls, pago_ok: mpOk });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
