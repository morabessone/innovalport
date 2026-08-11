// ============================================================================
// proveedores — lista de proveedores de Contabilium (SOLO LECTURA)
// ----------------------------------------------------------------------------
// La usa el flujo de Ingreso para poder elegir el proveedor real de un producto
// nuevo y así completar IDProveedor cuando se cree el concepto en Contabilium.
// Fuente: GET /api/proveedores/search?pageSize=&page=  -> { Items:[{Id, RazonSocial,
//   NombreFantasia, ...}] }. Nunca escribe a Contabilium.
// Credenciales: canal_config (tipo='contabilium').
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
const CB = "https://rest.contabilium.com";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
type DB = ReturnType<typeof db>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getToken(d: DB): Promise<string> {
  const { data: cfg } = await d.from("canal_config").select("*").eq("tipo", "contabilium").single();
  if (!cfg?.client_id || !cfg?.client_secret) throw new Error("Faltan credenciales de Contabilium en canal_config");
  const exp = cfg.expires_at ? new Date(cfg.expires_at).getTime() : 0;
  if (cfg.access_token && exp > Date.now() + 60_000) return cfg.access_token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.client_id, client_secret: cfg.client_secret });
  const r = await fetch(CB + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`token ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  const ttl = Number(j.expires_in || 3600);
  await d.from("canal_config").update({ access_token: j.access_token, expires_at: new Date(Date.now() + ttl * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("tipo", "contabilium");
  return j.access_token;
}
async function cbGet(path: string, tok: string) {
  const r = await fetch(CB + path, { headers: { Authorization: "Bearer " + tok, Accept: "application/json" } });
  if (!r.ok) throw new Error(`CB ${r.status} ${path}: ${(await r.text()).slice(0, 140)}`);
  return r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const d = db();
    const tok = await getToken(d);
    const out: { id: number; nombre: string }[] = [];
    const vistos = new Set<number>();
    for (let page = 1; page <= 40; page++) {
      const j = await cbGet(`/api/proveedores/search?pageSize=50&page=${page}`, tok);
      const items = j.Items ?? j.items ?? [];
      if (!Array.isArray(items) || items.length === 0) break;
      let nuevos = 0;
      for (const p of items) {
        const id = Number(p.Id ?? p.id ?? 0);
        if (!id || vistos.has(id)) continue;
        vistos.add(id); nuevos++;
        const nombre = String(p.RazonSocial ?? p.NombreFantasia ?? p.Nombre ?? `#${id}`).trim();
        out.push({ id, nombre });
      }
      if (nuevos === 0 || items.length < 50) break;
      await sleep(100);
    }
    out.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    return json({ ok: true, proveedores: out });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
