import { useEffect, useState, useCallback } from "react";
import { api } from "./lib/api.ts";
import { Panel } from "./views/Panel.tsx";
import { Ingreso } from "./views/Ingreso.tsx";
import { Movimiento } from "./views/Movimiento.tsx";
import { Devoluciones } from "./views/Devoluciones.tsx";

type Tab = "panel" | "ingreso" | "movimiento" | "devoluciones";
type Theme = "auto" | "light" | "dark";

const TABS: { id: Tab; label: string }[] = [
  { id: "panel", label: "Panel" },
  { id: "ingreso", label: "Ingreso" },
  { id: "movimiento", label: "Movimiento" },
  { id: "devoluciones", label: "Devoluciones" },
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
  const [tab, setTab] = useState<Tab>("panel");
  const [toast, setToast] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("cs-theme") as Theme) || "auto");

  useEffect(() => { applyTheme(theme); localStorage.setItem("cs-theme", theme); }, [theme]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

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
                <small>Centro de Stock</small>
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
            </div>
          </div>
        </div>
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
      </header>

      {tab === "panel" && <Panel notify={notify} />}
      {tab === "ingreso" && <Ingreso notify={notify} />}
      {tab === "movimiento" && <Movimiento notify={notify} />}
      {tab === "devoluciones" && <Devoluciones notify={notify} />}

      {toast && (
        <div className="toast" role="status">
          <span className="check">✓</span> {toast}
        </div>
      )}
    </div>
  );
}
