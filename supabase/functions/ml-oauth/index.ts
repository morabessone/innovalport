// ============================================================================
// ml-oauth — callback de OAuth de Mercado Libre
// ----------------------------------------------------------------------------
// Redirect URI a registrar en la app de ML DevCenter:
//   https://<PROJECT_REF>.supabase.co/functions/v1/ml-oauth
// Recibe el ?code=..., lo canjea por access_token + refresh_token contra
// https://api.mercadolibre.com/oauth/token y los guarda en canal_config.
// El client_id/secret se cargan antes en canal_config (tipo='ml').
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const REDIRECT = "https://tqgkkzbmupxsqufxjrjb.supabase.co/functions/v1/ml-oauth";

function db() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

function page(title: string, msg: string) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,-apple-system,sans-serif;background:linear-gradient(135deg,#0A1E4A,#123072);color:#fff;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center;max-width:420px;padding:24px"><div style="font-size:42px">◆</div><h1 style="font-weight:800;letter-spacing:-.02em">${title}</h1><p style="color:#A9B8DA;line-height:1.5">${msg}</p></div></body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err) return page("No se pudo conectar", "Mercado Libre devolvió: " + err);
  if (!code) return page("Falta el código", "No llegó el parámetro code de Mercado Libre.");

  const d = db();
  const { data: cfg } = await d.from("canal_config").select("*").eq("tipo", "ml").maybeSingle();
  if (!cfg?.client_id || !cfg?.client_secret) {
    return page("Falta configurar", "Todavía no está cargado el client_id / client_secret de Mercado Libre en el sistema.");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    code,
    redirect_uri: REDIRECT,
  });
  const r = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body,
  });
  const t = await r.text();
  if (!r.ok) return page("Error de Mercado Libre", r.status + ": " + t.slice(0, 200));

  const j = JSON.parse(t);
  await d.from("canal_config").update({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    seller_id: String(j.user_id ?? ""),
    expires_at: new Date(Date.now() + (Number(j.expires_in || 21600) * 1000)).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("tipo", "ml");

  return page("✓ Mercado Libre conectado", "Listo. Ya podés cerrar esta pestaña: el stock publicado se va a empezar a sincronizar en el Centro de Stock.");
});
