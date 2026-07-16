// ============================================================================
// ventas-sync — ingesta las ventas de Contabilium (ML + TN) y refleja el stock
// ----------------------------------------------------------------------------
// Contabilium unifica las ventas de ML y TN como comprobantes. Cada uno trae
// Origen (canal), Inventario (depósito) e Items (SKU + cantidad). Este job:
//   1) trae los comprobantes del rango (desde la última sync),
//   2) por cada factura NUEVA registra la venta (feed) y, si el depósito está
//      mapeado en cb_inventario_map, baja el stock de ese depósito (expande combos),
//   3) marca el comprobante para no re-procesarlo.
// El depósito FULL lo mantiene canal-sync (ML API), así que NO se mapea acá para
// evitar doble descuento. ?dry=1 devuelve los Inventarios vistos (para mapear).
// Credenciales de Contabilium: variables de entorno (no en el repo).
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
const CB = "https://rest.contabilium.com";
const CID = Deno.env.get("CONTABILIUM_CLIENT_ID") ?? "";
const CSEC = Deno.env.get("CONTABILIUM_CLIENT_SECRET") ?? "";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function cbToken(): Promise<string> {
  if (!CID || !CSEC) throw new Error("Faltan CONTABILIUM_CLIENT_ID / CONTABILIUM_CLIENT_SECRET");
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: CID, client_secret: CSEC });
  const r = await fetch(CB + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const t = await r.text(); if (!r.ok) throw new Error("cb token " + r.status); return JSON.parse(t).access_token;
}
async function cbGet(path: string, tok: string) {
  const r = await fetch(CB + path, { headers: { Authorization: "Bearer " + tok, Accept: "application/json" } });
  const t = await r.text(); if (!r.ok) throw new Error(`cb ${r.status} ${path}: ${t.slice(0, 120)}`);
  return t ? JSON.parse(t) : {};
}
function ymd(d: Date) { return d.toISOString().slice(0, 10); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  try {
    const tok = await cbToken();
    const { data: est } = await d.from("sync_estado").select("ultima_ok").eq("job", "ventas").maybeSingle();
    const desde = est?.ultima_ok ? new Date(new Date(est.ultima_ok).getTime() - 12 * 3600_000) : new Date(Date.now() - 3 * 86400_000);
    const hasta = new Date(Date.now() + 86400_000);
    const comps: Record<string, any>[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await cbGet(`/api/comprobantes/search?fechaDesde=${ymd(desde)}&fechaHasta=${ymd(hasta)}&page=${page}&pageSize=50`, tok);
      const items = (data.Items ?? []) as Record<string, any>[];
      comps.push(...items);
      if (items.length < 50) break;
    }
    const { data: invMap } = await d.from("cb_inventario_map").select("inventario_cb, deposito_codigo");
    const inv = new Map<number, string>((invMap ?? []).map((m: any) => [Number(m.inventario_cb), m.deposito_codigo]));
    const { data: combos } = await d.from("combos").select("combo_sku, base_sku, cantidad");
    const comboBy = new Map<string, { base: string; cant: number }>((combos ?? []).map((c: any) => [c.combo_sku.toLowerCase(), { base: c.base_sku.toLowerCase(), cant: Number(c.cantidad) }]));
    const { data: deps } = await d.from("depositos").select("id, codigo");
    const depId = new Map<string, string>((deps ?? []).map((x: any) => [x.codigo, x.id]));
    const { data: prods } = await d.from("productos").select("id, sku");
    const pid = new Map<string, string>((prods ?? []).map((p: any) => [String(p.sku).toLowerCase(), p.id]));
    const facturas = comps.filter((c) => String(c.TipoFc ?? "").startsWith("FC"));
    if (dry) {
      const seen: Record<number, { inventario: number; origenes: Record<string, number>; ejemplos: string[] }> = {};
      for (const c of facturas.slice(0, 45)) {
        const det = await cbGet(`/api/comprobantes/${Number(c.Id)}`, tok); await sleep(50);
        const invCb = Number(det.Inventario ?? 0); const or = String(det.Origen ?? "");
        seen[invCb] = seen[invCb] ?? { inventario: invCb, origenes: {}, ejemplos: [] };
        seen[invCb].origenes[or] = (seen[invCb].origenes[or] ?? 0) + 1;
        if (seen[invCb].ejemplos.length < 3) seen[invCb].ejemplos.push(`${det.Numero}: ${(det.Items ?? []).map((i: any) => i.Codigo).join(",")}`);
      }
      return json({ ok: true, dry: true, rango: [ymd(desde), ymd(hasta)], facturas: facturas.length, inventarios: Object.values(seen) });
    }
    const idset = facturas.map((c) => Number(c.Id));
    const { data: ya } = await d.from("cb_ventas").select("cb_id").in("cb_id", idset.length ? idset : [0]);
    const procesados = new Set((ya ?? []).map((r: any) => Number(r.cb_id)));
    let aplicadas = 0, sinMapear = 0, sinProducto = 0;
    const invSinMapear = new Set<number>();
    for (const c of facturas) {
      const cbId = Number(c.Id);
      if (procesados.has(cbId)) continue;
      const det = await cbGet(`/api/comprobantes/${cbId}`, tok);
      await sleep(60);
      const items = (det.Items ?? []) as Record<string, any>[];
      const invCb = Number(det.Inventario ?? 0);
      const dep = inv.get(invCb);
      const norm = items.map((it) => ({ sku: String(it.Codigo ?? "").toLowerCase(), cantidad: Number(it.Cantidad ?? 0) }));
      let aplicado = false;
      if (dep && depId.has(dep)) {
        for (const it of norm) {
          if (!it.sku || it.cantidad <= 0) continue;
          const combo = comboBy.get(it.sku);
          const baseSku = combo ? combo.base : it.sku;
          const qty = combo ? it.cantidad * combo.cant : it.cantidad;
          const producto = pid.get(baseSku);
          if (!producto) { sinProducto++; continue; }
          const dd = depId.get(dep)!;
          const { data: st } = await d.from("stock").select("cantidad").eq("producto_id", producto).eq("deposito_id", dd).maybeSingle();
          await d.from("stock").upsert({ producto_id: producto, deposito_id: dd, cantidad: Number(st?.cantidad ?? 0) - qty, updated_at: new Date().toISOString() }, { onConflict: "producto_id,deposito_id" });
        }
        aplicado = true; aplicadas++;
      } else { sinMapear++; if (invCb) invSinMapear.add(invCb); }
      await d.from("cb_ventas").upsert({ cb_id: cbId, numero: String(det.Numero ?? ""), fecha: det.FechaEmision ?? c.FechaEmision, origen: String(det.Origen ?? c.Origen ?? ""), inventario_cb: invCb, items: norm, aplicado }, { onConflict: "cb_id" });
    }
    await d.from("sync_estado").upsert({ job: "ventas", ultima_ok: new Date().toISOString() }, { onConflict: "job" });
    return json({ ok: true, comprobantes: comps.length, facturas: facturas.length, aplicadas, sin_mapear: sinMapear, sin_producto: sinProducto, inv_sin_mapear: [...invSinMapear] });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
