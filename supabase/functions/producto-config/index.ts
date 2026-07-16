// producto-config — guarda el stock mínimo de un producto (dispara la reposición).
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { producto_id, stock_minimo } = await req.json();
    if (!producto_id) return json({ ok: false, error: "falta producto_id" }, 400);
    const min = Math.max(0, Math.round(Number(stock_minimo ?? 0)));
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error } = await db.from("productos").update({ stock_minimo: min, updated_at: new Date().toISOString() }).eq("id", producto_id);
    if (error) return json({ ok: false, error: error.message }, 500);
    await db.from("auditoria").insert({ entidad: "producto", entidad_id: producto_id, accion: "set_minimo", detalle: { stock_minimo: min }, actor: "panel" }).then(() => {}, () => {});
    return json({ ok: true, stock_minimo: min });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
