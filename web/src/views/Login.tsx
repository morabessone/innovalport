import { useState } from "react";
import { signInWithGoogle } from "../lib/auth.ts";

// Ingreso con Google (restringido a @innovalport.com) y, como alternativa, el
// acceso con usuario/contraseña de siempre (compuerta local en el navegador).
const USER = "innovalport";
const PASS = "Riquelme10+";

export function Login({ error, onLocalOk }: { error?: string | null; onLocalOk: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [localErr, setLocalErr] = useState(false);

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await signInWithGoogle();
      // Redirige a Google; al volver, App levanta la sesión.
    } catch (e) {
      setErr((e as Error).message || "No se pudo iniciar sesión.");
      setBusy(false);
    }
  }

  function submitLocal(e: React.FormEvent) {
    e.preventDefault();
    if (u.trim() === USER && p === PASS) {
      localStorage.setItem("cs-auth", "1");
      onLocalOk();
    } else {
      setLocalErr(true);
    }
  }

  return (
    <div className="login-bg">
      <div className="login-card">
        <div className="login-brand">
          <span className="lmark">◆</span>
          <div><b>INNOVAL<span>PORT</span></b><small>Herramientas internas</small></div>
        </div>
        <h1 className="login-title">Ingresar</h1>
        <p className="muted" style={{ marginTop: -8, marginBottom: 20, fontSize: ".92rem", lineHeight: 1.5 }}>
          Accedé con tu cuenta de Google de Innovalport.
        </p>

        <button className="btn google-btn" onClick={go} disabled={busy}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>
          {busy ? "Redirigiendo a Google…" : "Continuar con Google"}
        </button>

        {(error || err) && <div className="login-err" style={{ marginTop: 14 }}>{error || err}</div>}

        <div className="login-or"><span>o con usuario</span></div>

        <form onSubmit={submitLocal} className="stack" style={{ gap: 12 }}>
          <div className="field">
            <label>Usuario</label>
            <input className="input" value={u} autoCapitalize="none" autoComplete="username"
              onChange={(e) => { setU(e.target.value); setLocalErr(false); }} placeholder="usuario" />
          </div>
          <div className="field">
            <label>Contraseña</label>
            <input className="input" type="password" value={p} autoComplete="current-password"
              onChange={(e) => { setP(e.target.value); setLocalErr(false); }} placeholder="••••••••" />
          </div>
          {localErr && <div className="login-err">Usuario o contraseña incorrectos.</div>}
          <button className="btn" type="submit" style={{ width: "100%", justifyContent: "center" }}>Entrar</button>
        </form>

        <div className="login-note">Google: solo cuentas <b>@innovalport.com</b></div>
      </div>
    </div>
  );
}
