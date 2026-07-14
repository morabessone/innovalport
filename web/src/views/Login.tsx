import { useState } from "react";

// Acceso único al Centro de Stock. Es una compuerta simple del lado del cliente
// (no reemplaza a un login con servidor); alcanza para que no se entre sin
// usuario y contraseña. Para permisos por persona más adelante: Supabase Auth.
const USER = "innovalport";
const PASS = "Riquelme10+";

export function Login({ onOk }: { onOk: () => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (u.trim() === USER && p === PASS) {
      localStorage.setItem("cs-auth", "1");
      onOk();
    } else {
      setErr(true);
    }
  }

  return (
    <div className="login-bg">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="lmark">◆</span>
          <div><b>INNOVAL<span>PORT</span></b><small>Centro de Stock</small></div>
        </div>
        <h1 className="login-title">Ingresar</h1>
        <div className="field">
          <label>Usuario</label>
          <input className="input" value={u} autoFocus autoCapitalize="none" autoComplete="username"
            onChange={(e) => { setU(e.target.value); setErr(false); }} placeholder="usuario" />
        </div>
        <div className="field">
          <label>Contraseña</label>
          <input className="input" type="password" value={p} autoComplete="current-password"
            onChange={(e) => { setP(e.target.value); setErr(false); }} placeholder="••••••••" />
        </div>
        {err && <div className="login-err">Usuario o contraseña incorrectos.</div>}
        <button className="btn primary" type="submit" style={{ width: "100%", justifyContent: "center", marginTop: 4 }}>Entrar</button>
      </form>
    </div>
  );
}
