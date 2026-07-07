import { useEffect, useState, useCallback } from "react";
import { api } from "./lib/api.ts";
import { Panel } from "./views/Panel.tsx";
import { Ingreso } from "./views/Ingreso.tsx";
import { Movimiento } from "./views/Movimiento.tsx";
import { Devoluciones } from "./views/Devoluciones.tsx";

type Tab = "panel" | "ingreso" | "movimiento" | "devoluciones";

const TABS: { id: Tab; label: string }[] = [
  { id: "panel", label: "Panel" },
  { id: "ingreso", label: "Ingreso" },
  { id: "movimiento", label: "Movimiento" },
  { id: "devoluciones", label: "Devoluciones" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("panel");
  const [toast, setToast] = useState<string | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbar-in">
          <div className="brand">
            <span className="box">📦</span> Centro de Stock
          </div>
          {api.connected
            ? <span className="conn live"><span className="dot" /> Conectado</span>
            : <span className="conn demo"><span className="dot" /> Modo demo</span>}
        </div>
        <div className="topbar-in" style={{ height: "auto", paddingBottom: 8 }}>
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
