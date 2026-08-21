// ============================================================================
// flexit-sync — Flexit (envío Flex): costo REAL de envío por entrega + cotización
// ----------------------------------------------------------------------------
// Autentica con el usuario/clave del cliente (canal_config tipo='flexit') y:
//   · accion "entregas" (default): GET /api/entregas?fecha= -> guarda el costo
//     REAL cobrado por entrega en flexit_entregas, resolviendo el SKU por
//     nro_venta contra ml_ordenes (best effort).
//   · accion "cotizar": POST /api/cotizacion { direccion, localidad, provincia }
//     -> devuelve el/los costo(s) estimado(s) por zona (para la Proyección).
// Nunca escribe en Flexit (solo lectura/cotización). Credenciales solo en la base.
// ============================================================================
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
const BASE = "https://www.flexit-app.net";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
type DB = SupabaseClient;
const low = (s: unknown) => String(s ?? "").trim().toLowerCase();
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const ymd = (d: Date) => d.toISOString().slice(0, 10);
// Muchas APIs PHP devuelven { info, msg, content } o directamente el array.
function unwrap(j: any): any { if (j == null) return null; if (Array.isArray(j)) return j; return j.content ?? j.data ?? j; }

async function flexitToken(d: DB): Promise<{ token: string | null; msg: string }> {
  const { data: cfg } = await d.from("canal_config").select("client_id, client_secret").eq("tipo", "flexit").maybeSingle();
  if (!cfg?.client_id || !cfg?.client_secret) return { token: null, msg: "faltan credenciales en canal_config tipo='flexit'" };
  try {
    const r = await fetch(`${BASE}/api/autenticacion/`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ usuario: cfg.client_id, password: cfg.client_secret }),
    });
    const j = await r.json().catch(() => null);
    const token = j?.content?.token ?? j?.token ?? null;
    return { token, msg: token ? "ok" : (j?.msg ?? `auth ${r.status}`) };
  } catch (e) { return { token: null, msg: String(e) }; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  const url = new URL(req.url);
  let body: any = {};
  try { body = await req.json(); } catch { /* sin body */ }
  const accion = body.accion ?? url.searchParams.get("accion") ?? "entregas";
  try {
    const { token, msg } = await flexitToken(d);
    if (!token) return json({ ok: false, error: `Flexit no autenticó: ${msg}` }, 400);

    if (accion === "cotizar") {
      const { direccion, localidad, provincia } = body;
      if (!direccion || !localidad || !provincia) return json({ ok: false, error: "faltan direccion, localidad o provincia" }, 400);
      const r = await fetch(`${BASE}/api/cotizacion/?token=${encodeURIComponent(token)}`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ direccion, localidad, provincia }),
      });
      const j = await r.json().catch(() => null);
      const arr = unwrap(j);
      const zonas = (Array.isArray(arr) ? arr : []).map((z: any) => ({ idzona: z.idzona, descripcion: z.descripcion, costo: num(z.costo) }));
      const costo = zonas.length ? Math.min(...zonas.map((z) => z.costo).filter((c) => c > 0)) : 0;
      return json({ ok: true, costo: Number.isFinite(costo) ? costo : 0, zonas });
    }

    // accion "entregas": costo real por entrega.
    const dias = Number(url.searchParams.get("dias") ?? body.dias ?? 60) || 60;
    const desde = ymd(new Date(Date.now() - dias * 86400_000));
    const r = await fetch(`${BASE}/api/entregas/?token=${encodeURIComponent(token)}&fecha=${desde}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return json({ ok: false, error: `entregas ${r.status}` }, 500);
    const j = await r.json().catch(() => null);
    const arr = unwrap(j);
    const entregas = Array.isArray(arr) ? arr : [];

    // Mapa nro_venta -> sku desde ml_ordenes (order_id como texto).
    const { data: ords } = await d.from("ml_ordenes").select("order_id, sku");
    const skuByVenta = new Map<string, string>();
    for (const o of (ords ?? []) as any[]) if (o.order_id && o.sku) skuByVenta.set(String(o.order_id), String(o.sku));

    const rows = entregas.map((e: any) => {
      const nro = String(e.nro_venta ?? e.codinterno ?? "");
      return {
        nro_venta: nro, costo: num(e.costo), zona: e.zona ?? null, estado: e.estado ?? null,
        direccion: e.direccion ?? null, fecha: e.fecha_conector ?? e.fecha ?? null,
        codinterno: e.codinterno ?? null, nro_guia: e.nro_guia ?? null,
        sku: skuByVenta.get(nro) ? low(skuByVenta.get(nro)) : null,
        updated_at: new Date().toISOString(),
      };
    }).filter((x) => x.nro_venta);

    let guardadas = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await d.from("flexit_entregas").upsert(chunk, { onConflict: "nro_venta" });
      if (error) return json({ ok: false, error: error.message, guardadas }, 500);
      guardadas += chunk.length;
    }
    const conSku = rows.filter((x) => x.sku).length;
    const total = rows.reduce((s, x) => s + x.costo, 0);
    return json({ ok: true, entregas: rows.length, guardadas, con_sku: conSku, costo_total: Math.round(total), desde });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
