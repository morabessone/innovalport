// ============================================================================
// publicacion-sugerir — borrador SEO de publicación para productos SIN publicar
// ----------------------------------------------------------------------------
// Para un producto de Contabilium que todavía no tiene publicación, arma un
// BORRADOR optimizado (título, descripción, atributos, categoría) con Claude,
// siguiendo buenas prácticas de posicionamiento de Mercado Libre, y junta
// imágenes de REFERENCIA desde el catálogo de ML. NUNCA publica nada.
//
// Key de Anthropic: env ANTHROPIC_API_KEY o canal_config (tipo='anthropic',
// campo client_secret). Cargá una de las dos para que genere el copy.
// Entrada: { producto_id } (uno) o { limit } (varios pendientes).
// ============================================================================
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
const API = "https://api.mercadolibre.com";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function db() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
type DB = ReturnType<typeof db>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function anthropicKey(d: DB): Promise<string> {
  const env = Deno.env.get("ANTHROPIC_API_KEY");
  if (env) return env;
  const { data } = await d.from("canal_config").select("client_secret").eq("tipo", "anthropic").maybeSingle();
  return data?.client_secret ?? "";
}
async function mlToken(d: DB): Promise<string | null> {
  const { data: cfg } = await d.from("canal_config").select("*").eq("tipo", "ml").maybeSingle();
  if (!cfg?.access_token) return null;
  const exp = cfg.expires_at ? new Date(cfg.expires_at).getTime() : 0;
  if (exp > Date.now() + 60_000) return cfg.access_token;
  try {
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token });
    const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    if (!r.ok) return null;
    const j = await r.json();
    await d.from("canal_config").update({ access_token: j.access_token, refresh_token: j.refresh_token ?? cfg.refresh_token, expires_at: new Date(Date.now() + Number(j.expires_in || 21600) * 1000).toISOString() }).eq("tipo", "ml");
    return j.access_token;
  } catch { return null; }
}
async function mlTry(path: string, token: string | null): Promise<any | null> {
  try {
    const r = await fetch(API + path, { headers: token ? { Authorization: `Bearer ${token}`, Accept: "application/json" } : { Accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Imágenes de referencia desde el catálogo de ML (el search público da 403).
async function imagenesReferencia(nombre: string, token: string | null): Promise<string[]> {
  const s = await mlTry(`/products/search?site_id=MLA&status=active&q=${encodeURIComponent(nombre)}&limit=1`, token);
  const prod = (s?.results ?? [])[0];
  if (!prod?.id) return [];
  const det = await mlTry(`/products/${prod.id}`, token);
  return ((det?.pictures ?? []) as any[]).map((p) => String(p.url || p.secure_url || "")).filter(Boolean).slice(0, 6);
}

const SYS = `Sos un experto en SEO y redacción de publicaciones de Mercado Libre Argentina.
Escribí como un vendedor profesional que sabe cómo el buscador de Mercado Libre rankea e indexa.

TÍTULO (máx 60 caracteres): Producto + Marca + Modelo + atributo(s) clave (medida, capacidad, color, material), en ese orden. Palabras que la gente busca. Sin signos, sin MAYÚSCULAS gritadas, sin emojis. PROHIBIDO: "oferta", "promoción", "envío gratis", "el mejor". No repitas palabras.
DESCRIPCIÓN: primer párrafo con el beneficio principal y palabras clave naturales; después ficha técnica en viñetas (medidas, materiales, contenido de la caja, compatibilidad, garantía); cerrá con usos/beneficios. Sin datos inventados.
ATRIBUTOS: completá los que se deduzcan del nombre (marca, modelo, color, material, medidas). Si no se sabe, omitilo.

Devolvé SOLO un JSON válido: {"titulo": string, "descripcion": string, "atributos": [{"nombre": string, "valor": string}], "keywords": [string]}`;

async function generar(key: string, nombre: string, sku: string, categoria?: string): Promise<Record<string, unknown> | null> {
  if (!key) return null;
  const user = `Producto (nombre interno de Contabilium): "${nombre}". SKU: ${sku}.${categoria ? ` Categoría sugerida por ML: ${categoria}.` : ""} Generá el borrador optimizado para Mercado Libre Argentina.`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYS, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const txt = (j.content?.[0]?.text ?? "").trim();
    const m = txt.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const d = db();
  try {
    const payload = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const unico = payload.producto_id ? String(payload.producto_id) : null;
    const limit = Math.min(Number(payload.limit ?? 6), 12);
    const token = await mlToken(d);
    const key = await anthropicKey(d);

    const { data: conPub } = await d.from("publicaciones").select("producto_id");
    const publicados = new Set((conPub ?? []).map((r: any) => r.producto_id).filter(Boolean));
    const { data: conSug } = await d.from("publicacion_sugerencias").select("producto_id");
    const yaSugeridos = new Set((conSug ?? []).map((r: any) => r.producto_id));

    let q = d.from("productos").select("id, sku, nombre").eq("activo", true);
    if (unico) q = q.eq("id", unico);
    const { data: prods } = await q.limit(unico ? 1 : 200);

    const objetivo = (prods ?? []).filter((p: any) => unico ? true : (!publicados.has(p.id) && !yaSugeridos.has(p.id))).slice(0, unico ? 1 : limit);

    let hechos = 0;
    for (const p of objetivo as any[]) {
      const nombre = String(p.nombre ?? p.sku);
      const pred = token ? await mlTry(`/sites/MLA/domain_discovery/search?limit=1&q=${encodeURIComponent(nombre)}`, token) : null;
      const categoria = Array.isArray(pred) && pred[0]?.category_name ? String(pred[0].category_name) : undefined;
      const imagenes = await imagenesReferencia(nombre, token);
      const gen = await generar(key, nombre, String(p.sku), categoria);

      await d.from("publicacion_sugerencias").upsert({
        producto_id: p.id, sku: p.sku,
        titulo_sugerido: gen?.titulo ?? nombre,
        descripcion_sugerida: gen?.descripcion ?? "",
        categoria_sugerida: categoria ?? null,
        atributos: gen?.atributos ?? [],
        imagenes, fuente_imagenes: imagenes.length ? "catálogo ML (referencia)" : null,
        estado: "borrador", updated_at: new Date().toISOString(),
      }, { onConflict: "producto_id" });
      hechos++;
      await sleep(150);
    }

    return json({ ok: true, generados: hechos, con_copy: key ? true : false });
  } catch (e) { return json({ ok: false, error: String(e) }, 500); }
});
