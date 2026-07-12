import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { Auditoria } from "../lib/types.ts";

const ACCION_LABEL: Record<string, string> = {
  movimiento: "Movimiento", ingreso: "Ingreso", confirmado: "Ingreso confirmado",
  cargada: "Devolución cargada", en_oficina: "Devolución en oficina",
  apta: "Devolución apta", no_apta: "Devolución no apta",
  baja: "Producto dado de baja", reactivar: "Producto reactivado",
  ajuste: "Ajuste de inventario", anulado: "Remito anulado", error: "Error de sync",
};
const ENT_ICON: Record<string, string> = {
  remito: "⇄", ingreso: "＋", devolucion: "↩", producto: "◆", inventario: "▦", cb_queue: "⚠",
};

export function Historial() {
  const [items, setItems] = useState<Auditoria[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try { setItems(await api.auditoria(80)); } finally { setLoading(false); }
    })();
  }, []);

  return (
    <div className="stack">
      <div className="section-head">
        <div><span className="eyebrow">Historial</span><h2>Actividad reciente</h2></div>
        <span className="muted">Quién hizo qué y cuándo</span>
      </div>

      <div className="card">
        {loading && <div className="empty">Cargando…</div>}
        {!loading && items.length === 0 && <div className="empty">Sin actividad todavía.</div>}
        <ul className="timeline">
          {items.map((a) => (
            <li key={a.id}>
              <span className="tl-ico">{ENT_ICON[a.entidad] ?? "•"}</span>
              <div className="tl-body">
                <b>{ACCION_LABEL[a.accion] ?? a.accion}</b>
                <span className="muted"> · {a.entidad}</span>
              </div>
              <div className="tl-meta">
                <span className="mono">{a.actor ?? "—"}</span>
                <span>{new Date(a.created_at).toLocaleString("es-AR")}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
