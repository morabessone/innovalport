import { useState } from "react";

export type Section = "home" | "panel" | "reponer" | "ingreso" | "movimiento" | "devoluciones" | "inventario" | "historial";

const STOCK_TABS: { id: Section; label: string }[] = [
  { id: "panel", label: "Panel" },
  { id: "reponer", label: "Reponer" },
  { id: "ingreso", label: "Ingreso" },
  { id: "movimiento", label: "Movimiento" },
  { id: "devoluciones", label: "Devoluciones" },
  { id: "inventario", label: "Inventario" },
  { id: "historial", label: "Historial" },
];

const STOCK_IDS = STOCK_TABS.map((t) => t.id);

// Menú lateral de navegación. Inicio arriba; Central de Stock como grupo
// desplegable con sus submenús; Publicaciones deshabilitado (Próximamente).
export function Sidebar({ section, onNavigate }: { section: Section; onNavigate: (s: Section) => void }) {
  const inStock = STOCK_IDS.includes(section);
  const [openStock, setOpenStock] = useState(true);

  return (
    <nav className="sidebar-nav" aria-label="Navegación principal">
      <button
        className={"side-item" + (section === "home" ? " active" : "")}
        onClick={() => onNavigate("home")}
      >
        <span className="side-ico" aria-hidden="true">🏠</span> Inicio
      </button>

      <div className="side-group">
        <button
          className={"side-item side-parent" + (inStock ? " on" : "")}
          onClick={() => setOpenStock((v) => !v)}
          aria-expanded={openStock}
        >
          <span className="side-ico" aria-hidden="true">📦</span>
          <span className="side-label">Central de Stock</span>
          <span className={"side-chev" + (openStock ? " open" : "")} aria-hidden="true">▸</span>
        </button>
        {openStock && (
          <div className="side-subs">
            {STOCK_TABS.map((t) => (
              <button
                key={t.id}
                className={"side-sub" + (section === t.id ? " active" : "")}
                onClick={() => onNavigate(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="side-group">
        <div className="side-item disabled" aria-disabled="true" title="Próximamente">
          <span className="side-ico" aria-hidden="true">🏷️</span>
          <span className="side-label">Publicaciones</span>
          <span className="side-soon">Pronto</span>
        </div>
      </div>
    </nav>
  );
}
