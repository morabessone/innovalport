// ============================================================================
// ventas-sync — registra las ventas de Contabilium (ML + TN) para el feed
// ----------------------------------------------------------------------------
// Contabilium unifica ML y TN como comprobantes (Origen, Inventario, Items).
// YA NO descuenta stock: Contabilium descuenta el depósito en cada venta y
// deposito-sync trae ese número real cada 5 min (fuente de verdad única). Acá
// solo se REGISTRA la venta en cb_ventas (historial / feed). ?dry=1 lista los
// Inventarios vistos (para mapear). Credenciales SIEMPRE de canal_config.
// ============================================================================
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
const CB = "https://rest.contabilium.com";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Contabilium usa OAuth2 client_credentials: client_id = email, client_secret =
// API Key. Fuente única: canal_config (igual que deposito-sync / stock-sync).
async function cbToken(d: SupabaseClient): Promise<string> {
  const { data: cfg } = await d.from("canal_config").select("*").eq("tipo", "contabilium").single();
  if (!cfg?.client_id || !cfg?.client_secret) throw new Error("Faltan credenciales de Contabilium en canal_config (client_id = email, client_secret = API Key)");
  const exp = cfg.expires_at ? new Date(cfg.expires_at).getTime() : 0;
  if (cfg.access_token && exp > Date.now() + 60_000) return cfg.access_token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.client_id, client_secret: cfg.client_secret });
  const r = await fetch(CB + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const t = await r.text(); if (!r.ok) throw new Error("cb token " + r.status);
  const j = JSON.parse(t);
  const ttl = Number(j.expires_in || 3600);
  await d.from("canal_config").update({ access_token: j.access_token, expires_at: new Date(Date.now() + ttl * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("tipo", "contabilium");
  return j.access_token;
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
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const diasParam = Number(url.searchParams.get("dias") ?? 0) || 0;
  const rebuild = url.searchParams.get("rebuild") === "1"; // re-procesa aunque ya exista (backfill de montos)
  try {
    const tok = await cbToken(d);
    const { data: est } = await d.from("sync_estado").select("ultima_ok").eq("job", "ventas").maybeSingle();
    const desde = diasParam > 0
      ? new Date(Date.now() - diasParam * 86400_000)
      : (est?.ultima_ok ? new Date(new Date(est.ultima_ok).getTime() - 12 * 3600_000) : new Date(Date.now() - 3 * 86400_000));
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
    const { data: deps } = await d.from("depositos").select("id, codigo");
    const depId = new Map<string, string>((deps ?? []).map((x: any) => [x.codigo, x.id]));
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
    // "Ya procesadas" = las que ya tienen el importe cargado (total>0). Así el
    // backfill es auto-reparable: cada corrida completa las que faltan.
    const { data: ya } = await d.from("cb_ventas").select("cb_id").gt("total", 0).in("cb_id", idset.length ? idset : [0]);
    const procesados = new Set((ya ?? []).map((r: any) => Number(r.cb_id)));
    const maxProc = Number(url.searchParams.get("max") ?? 130) || 130; // cota de detalles por corrida
    let procCount = 0;
    let registradas = 0, sinMapear = 0;
    const invSinMapear = new Set<number>();
    let muestraItem: string[] | null = null;
    // Importe de un ítem del comprobante (con IVA). Fallbacks por si cambian nombres.
    const montoItem = (it: Record<string, any>): number => {
      const cant = Number(it.Cantidad ?? 0);
      const total = Number(it.Total ?? it.Importe ?? it.SubTotal ?? it.Subtotal ?? 0);
      if (total > 0) return total;
      const pu = Number(it.PrecioFinal ?? it.Precio ?? it.PrecioUnitario ?? it.ImporteUnitario ?? 0);
      return pu * cant;
    };
    for (const c of facturas) {
      const cbId = Number(c.Id);
      if (procesados.has(cbId) && !rebuild) continue;
      if (procCount >= maxProc) break;
      procCount++;
      const det = await cbGet(`/api/comprobantes/${cbId}`, tok);
      await sleep(60);
      const items = (det.Items ?? []) as Record<string, any>[];
      if (!muestraItem && items[0]) muestraItem = Object.keys(items[0]);
      const invCb = Number(det.Inventario ?? 0);
      const dep = inv.get(invCb);
      const norm = items.map((it) => ({ sku: String(it.Codigo ?? "").toLowerCase(), cantidad: Number(it.Cantidad ?? 0), monto: Math.round(montoItem(it)) }));
      const totalVenta = norm.reduce((s, i) => s + i.monto, 0);
      if (dep && depId.has(dep)) registradas++; else { sinMapear++; if (invCb) invSinMapear.add(invCb); }
      await d.from("cb_ventas").upsert({ cb_id: cbId, numero: String(det.Numero ?? ""), fecha: det.FechaEmision ?? c.FechaEmision, origen: String(det.Origen ?? c.Origen ?? ""), inventario_cb: invCb, items: norm, total: totalVenta, aplicado: false }, { onConflict: "cb_id" });
    }
    if (!rebuild && !diasParam) await d.from("sync_estado").upsert({ job: "ventas", ultima_ok: new Date().toISOString() }, { onConflict: "job" });
    return json({ ok: true, comprobantes: comps.length, facturas: facturas.length, procesadas: procCount, registradas, sin_mapear: sinMapear, muestra_item: muestraItem });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
