// ============================================================================
// finanzas-guardar — escribe los parámetros financieros en la base (NO en
// Contabilium). Dos acciones:
//   { accion: "config", config: {...} }            -> finanzas_config (id=1)
//   { accion: "producto", producto_id, datos:{...}} -> producto_finanzas
// Solo afecta la base local; alimenta el cálculo del módulo Finanzas.
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
const num = (v: unknown, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  try {
    const { accion, config, producto_id, datos } = await req.json();

    if (accion === "config") {
      const c = config ?? {};
      const patch: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() };
      for (const k of ["tasa_anual", "comision_ml", "comision_tn", "dias_cobro_ml", "dias_cobro_tn", "costo_envio_default", "margen_min", "percepciones_pct", "financiacion_mp_pct", "tn_gasto_pct", "envio_full_default", "dias_acreditacion_ml"]) {
        if (c[k] != null) patch[k] = num(c[k]);
      }
      const { error } = await d.from("finanzas_config").upsert(patch, { onConflict: "id" });
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true });
    }

    if (accion === "producto") {
      if (!producto_id) return json({ ok: false, error: "falta producto_id" }, 400);
      const x = datos ?? {};
      const { error } = await d.from("producto_finanzas").upsert({
        producto_id,
        proveedor: x.proveedor ?? null,
        precio_compra: x.precio_compra != null ? num(x.precio_compra) : null,
        condicion_pago_dias: Math.round(num(x.condicion_pago_dias)),
        tasa_financiacion: num(x.tasa_financiacion),
        envio_flex: x.envio_flex != null ? num(x.envio_flex) : 0,
        condicion_pago_label: x.condicion_pago_label ?? null,
        canal_principal: x.canal_principal ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "producto_id" });
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ ok: false, error: "acción desconocida" }, 400);
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
