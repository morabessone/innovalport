import { useEffect, useState, useCallback } from "react";
import { api } from "./lib/api.ts";
import { supabase } from "./lib/supabase.ts";
import { emailAllowed, signOut } from "./lib/auth.ts";
import { Panel } from "./views/Panel.tsx";
import { Reponer } from "./views/Reponer.tsx";
import { Ingreso } from "./views/Ingreso.tsx";
import { Movimiento } from "./views/Movimiento.tsx";
import { Devoluciones } from "./views/Devoluciones.tsx";
import { Inventario } from "./views/Inventario.tsx";
import { Historial } from "./views/Historial.tsx";
import { Login } from "./views/Login.tsx";
import { Home } from "./views/Home.tsx";

type Tab = "panel" | "reponer" | "ingreso" | "movimiento" | "devoluciones" | "inventario" | "historial";
type View = "home" | "stock";
type Theme = "auto" | "light" | "dark";

const TABS: { id: Tab; label: string }[] = [
  { id: "panel", label: "Panel" },
  { id: "reponer", label: "Reponer" },
  { id: "ingreso", label: "Ingreso" },
  { id: "movimiento", label: "Movimiento" },
  { id: "devoluciones", label: "Devoluciones" },
  { id: "inventario", label: "Inventario" },
  { id: "historial", label: "Historial" },
];

const THEME_NEXT: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };
const THEME_UI: Record<Theme, { icon: string; label: string }> = {
  auto: { icon: "◐", label: "Auto" },
  light: { icon: "☀", label: "Claro" },
  dark: { icon: "☾", label: "Oscuro" },
};

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "auto") root.removeAttribute("data-theme"); // sigue el día/noche del sistema
  else root.setAttribute("data-theme", t);
}

export function App() {
  const [view, setView] = useState<View>("home");
  const [tab, setTab] = useState<Tab>("panel");
  const [toast, setToast] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("cs-theme") as Theme) || "auto");

  // ---- sesión: Google (Supabase) o el acceso local usuario/contraseña ----
  const [email, setEmail] = useState<string | null>(null);
  const [localAuth, setLocalAuth] = useState<boolean>(() => localStorage.getItem("cs-auth") === "1");
  const [authReady, setAuthReady] = useState(false);
  const [authErr, setAuthErr] = useState<string | null>(null);

  useEffect(() => { applyTheme(theme); localStorage.setItem("cs-theme", theme); }, [theme]);

  useEffect(() => {
    if (!supabase) { setEmail("demo@innovalport.com"); setAuthReady(true); return; } // modo demo

    let mounted = true;
    const resolve = (session: { user?: { email?: string | null } } | null) => {
      if (!mounted) return;
      const mail = session?.user?.email ?? null;
      if (session && !emailAllowed(mail)) {
        // La cuenta no es del dominio permitido: cerrar sesión y avisar.
        setAuthErr(`La cuenta ${mail ?? ""} no pertenece a @innovalport.com. Usá tu cuenta de Innovalport.`);
        setEmail(null);
        supabase!.auth.signOut();
      } else {
        setAuthErr(null);
        setEmail(mail);
      }
      setAuthReady(true);
    };

    supabase.auth.getSession().then(({ data }) => resolve(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => resolve(session));
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  async function logout() {
    await signOut();
    localStorage.removeItem("cs-auth");
    setLocalAuth(false);
    setEmail(null);
    setView("home");
  }

  // Identidad activa: la cuenta de Google, o el usuario local si entró por ahí.
  const identity = email ?? (localAuth ? "innovalport" : null);

  if (!authReady && !localAuth) {
    return <div className="login-bg"><div className="auth-loading">Cargando…</div></div>;
  }
  if (!identity) return <Login error={authErr} onLocalOk={() => setLocalAuth(true)} />;

  const enStock = view === "stock";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brandbar">
          <div className="bar-in">
            <div className="brand">
              <svg className="mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                <path d="M16 2 28 9v14L16 30 4 23V9z" stroke="#7EE6FF" stroke-width="1.6" opacity=".55" />
                <path d="M10 20l6-10 6 10-6-3z" fill="url(#g)" />
                <defs>
                  <linearGradient id="g" x1="10" y1="10" x2="22" y2="20" gradientUnits="userSpaceOnUse">
                    <stop stop-color="#12B4EF" /><stop offset="1" stop-color="#3E86FF" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="wm">
                <b>INNOVAL<span>PORT</span></b>
                <small>{enStock ? "Central de Stock" : "Herramientas internas"}</small>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {enStock && (
                <button className="theme-btn" onClick={() => setView("home")} title="Volver al Inicio">
                  <span aria-hidden="true">←</span> Inicio
                </button>
              )}
              <button
                className="theme-btn"
                onClick={() => setTheme(THEME_NEXT[theme])}
                title={`Tema: ${THEME_UI[theme].label} (clic para cambiar)`}
              >
                <span aria-hidden="true">{THEME_UI[theme].icon}</span> {THEME_UI[theme].label}
              </button>
              {api.connected
                ? <span className="conn live"><span className="dot" /> Conectado</span>
                : <span className="conn demo"><span className="dot" /> Modo demo</span>}
              <button className="theme-btn" onClick={logout} title="Cerrar sesión">Salir</button>
            </div>
          </div>
        </div>
        {enStock && (
          <div className="navbar">
            <div className="bar-in">
              <nav className="tabs">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    className={"tab" + (tab === t.id ? " active" : "")}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </nav>
            </div>
          </div>
        )}
      </header>

      {view === "home" && <Home email={identity} onOpen={(t) => t === "stock" && setView("stock")} />}

      {enStock && (
        <>
          {tab === "panel" && <Panel notify={notify} />}
          {tab === "reponer" && <Reponer notify={notify} />}
          {tab === "ingreso" && <Ingreso notify={notify} />}
          {tab === "movimiento" && <Movimiento notify={notify} />}
          {tab === "devoluciones" && <Devoluciones notify={notify} />}
          {tab === "inventario" && <Inventario notify={notify} />}
          {tab === "historial" && <Historial />}
        </>
      )}

      {toast && (
        <div className="toast" role="status">
          <span className="check">✓</span> {toast}
        </div>
      )}
    </div>
  );
}
