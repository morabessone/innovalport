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
import { Publicaciones, type PubTab } from "./views/Publicaciones.tsx";
import { Finanzas, type FinTab } from "./views/Finanzas.tsx";
import { Sidebar, type Section } from "./views/Sidebar.tsx";

type Theme = "auto" | "light" | "dark";

const SECTION_TITLE: Record<Section, string> = {
  home: "Herramientas internas",
  panel: "Central de Stock",
  reponer: "Central de Stock",
  ingreso: "Central de Stock",
  movimiento: "Central de Stock",
  devoluciones: "Central de Stock",
  inventario: "Central de Stock",
  historial: "Central de Stock",
  pub_activas: "Publicaciones",
  pub_pendientes: "Publicaciones",
  pub_optim: "Publicaciones",
  fin_resumen: "Finanzas",
  fin_producto: "Finanzas",
  fin_proveedor: "Finanzas",
  fin_capital: "Finanzas",
  fin_matriz: "Finanzas",
  fin_proyeccion: "Finanzas",
};
const PUB_SUBTAB: Partial<Record<Section, PubTab>> = {
  pub_activas: "activas", pub_pendientes: "pendientes", pub_optim: "optim",
};
const FIN_SUBTAB: Partial<Record<Section, FinTab>> = {
  fin_resumen: "resumen", fin_producto: "producto", fin_proveedor: "proveedor", fin_capital: "capital", fin_matriz: "matriz", fin_proyeccion: "proyeccion",
};

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
  const [section, setSection] = useState<Section>("home");
  const [toast, setToast] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("cs-theme") as Theme) || "auto");
  const [menuOpen, setMenuOpen] = useState(false);

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
    setSection("home");
  }

  function navigate(s: Section) {
    setSection(s);
    setMenuOpen(false);
  }

  // Identidad activa: la cuenta de Google, o el usuario local si entró por ahí.
  const identity = email ?? (localAuth ? "innovalport" : null);

  if (!authReady && !localAuth) {
    return <div className="login-bg"><div className="auth-loading">Cargando…</div></div>;
  }
  if (!identity) return <Login error={authErr} onLocalOk={() => setLocalAuth(true)} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brandbar">
          <div className="bar-in">
            <div className="brand">
              <button
                className="menu-btn"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="Abrir menú"
                aria-expanded={menuOpen}
              >☰</button>
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
                <small>{SECTION_TITLE[section]}</small>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
      </header>

      <div className="shell">
        {menuOpen && <div className="side-backdrop" onClick={() => setMenuOpen(false)} />}
        <aside className={"sidebar" + (menuOpen ? " open" : "")}>
          <Sidebar section={section} onNavigate={navigate} />
        </aside>

        <main className="content">
          {section === "home" && <Home email={identity} onOpen={(t) => setSection(t === "publicaciones" ? "pub_activas" : t === "finanzas" ? "fin_resumen" : "panel")} />}
          {section === "panel" && <Panel notify={notify} />}
          {section === "reponer" && <Reponer notify={notify} />}
          {section === "ingreso" && <Ingreso notify={notify} />}
          {section === "movimiento" && <Movimiento notify={notify} />}
          {section === "devoluciones" && <Devoluciones notify={notify} />}
          {section === "inventario" && <Inventario notify={notify} />}
          {section === "historial" && <Historial />}
          {PUB_SUBTAB[section] && <Publicaciones subtab={PUB_SUBTAB[section]!} notify={notify} />}
          {FIN_SUBTAB[section] && <Finanzas subtab={FIN_SUBTAB[section]!} notify={notify} />}
        </main>
      </div>

      {toast && (
        <div className="toast" role="status">
          <span className="check">✓</span> {toast}
        </div>
      )}
    </div>
  );
}
