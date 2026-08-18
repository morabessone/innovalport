import { useState } from "react";

export type Section =
  | "home"
  | "panel" | "reponer" | "ingreso" | "movimiento" | "devoluciones" | "inventario" | "historial"
  | "pub_activas" | "pub_pendientes" | "pub_optim";

const STOCK_TABS: { id: Section; label: string }[] = [
  { id: "panel", label: "Panel" },
  { id: "reponer", label: "Reponer" },
  { id: "ingreso", label: "Ingreso" },
  { id: "movimiento", label: "Movimiento" },
  { id: "devoluciones", label: "Devoluciones" },
  { id: "inventario", label: "Inventario" },
  { id: "historial", label: "Historial" },
];
const PUB_TABS: { id: Section; label: string }[] = [
  { id: "pub_activas", label: "Publicaciones activas" },
  { id: "pub_pendientes", label: "Pendientes" },
  { id: "pub_optim", label: "Optimizaciones" },
];

const STOCK_IDS = STOCK_TABS.map((t) => t.id);
const PUB_IDS = PUB_TABS.map((t) => t.id);

// Menú lateral: Inicio + dos grupos desplegables (Central de Stock y Publicaciones).
export function Sidebar({ section, onNavigate }: { section: Section; onNavigate: (s: Section) => void }) {
  const inStock = STOCK_IDS.includes(section);
  const inPub = PUB_IDS.includes(section);
  const [openStock, setOpenStock] = useState(true);
  const [openPub, setOpenPub] = useState(true);

  return (
    <nav className="sidebar-nav" aria-label="Navegación principal">
      <button className={"side-item" + (section === "home" ? " active" : "")} onClick={() => onNavigate("home")}>
        <span className="side-ico" aria-hidden="true">🏠</span> Inicio
      </button>

      <div className="side-group">
        <button className={"side-item side-parent" + (inStock ? " on" : "")} onClick={() => setOpenStock((v) => !v)} aria-expanded={openStock}>
          <span className="side-ico" aria-hidden="true">📦</span>
          <span className="side-label">Central de Stock</span>
          <span className={"side-chev" + (openStock ? " open" : "")} aria-hidden="true">▸</span>
        </button>
        {openStock && (
          <div className="side-subs">
            {STOCK_TABS.map((t) => (
              <button key={t.id} className={"side-sub" + (section === t.id ? " active" : "")} onClick={() => onNavigate(t.id)}>{t.label}</button>
            ))}
          </div>
        )}
      </div>

      <div className="side-group">
        <button className={"side-item side-parent" + (inPub ? " on" : "")} onClick={() => setOpenPub((v) => !v)} aria-expanded={openPub}>
          <span className="side-ico" aria-hidden="true">🏷️</span>
          <span className="side-label">Publicaciones</span>
          <span className={"side-chev" + (openPub ? " open" : "")} aria-hidden="true">▸</span>
        </button>
        {openPub && (
          <div className="side-subs">
            {PUB_TABS.map((t) => (
              <button key={t.id} className={"side-sub" + (section === t.id ? " active" : "")} onClick={() => onNavigate(t.id)}>{t.label}</button>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}
