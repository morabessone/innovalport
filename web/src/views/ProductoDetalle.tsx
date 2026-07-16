import { useState } from "react";
import { api } from "../lib/api.ts";
import type { StockConsolidado } from "../lib/types.ts";

const DEPS: { code: string; label: string; hint: string }[] = [
  { code: "GEN", label: "Genpol", hint: "Depósito principal (bulk)" },
  { code: "FULL", label: "Full", hint: "Bodega de Mercado Libre" },
  { code: "FLX", label: "Flexit", hint: "Pool físico ML Flex + Tienda Nube" },
  { code: "OFI", label: "Oficina", hint: "Devoluciones / ajustes" },
];
const CANALES: { key: string; label: string }[] = [
  { key: "ml_full", label: "Mercado Libre Full" },
  { key: "ml_flex", label: "Mercado Libre Flex" },
  { key: "tn", label: "Tienda Nube" },
];

export function ProductoDetalle({ producto, onClose, onSaved, notify }: {
  producto: StockConsolidado;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  notify: (m: string) => void;
}) {
  const s = producto;
  const pool = s.por_deposito.FLX ?? 0;
  const [min, setMin] = useState<number>(s.stock_minimo ?? 0);
  const [saving, setSaving] = useState(false);
  const dirty = min !== (s.stock_minimo ?? 0);

  async function guardar() {
    setSaving(true);
    try {
      await api.setMinimo(s.producto_id, min);
      await onSaved();
      notify(`Mínimo de ${s.sku} guardado en ${min}`);
    } catch (e) {
      notify("No se pudo guardar: " + (e as Error).message);
    } finally { setSaving(false); }
  }

  const valorCosto = Math.round(Math.max(0, s.total) * (s.costo || 0));

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">Producto</span>
            <h3 style={{ margin: "2px 0 0" }}>{s.sku}</h3>
            <small className="muted">{s.nombre}</small>
          </div>
          <button className="btn ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        <div className="det-grid">
          <div className="det-block">
            <h4>Stock por depósito</h4>
            <div className="det-rows">
              {DEPS.map((d) => {
                const v = s.por_deposito[d.code] ?? 0;
                return (
                  <div className="det-row" key={d.code}>
                    <span title={d.hint}>{d.label}</span>
                    <b className="mono" style={{ color: v < 0 ? "var(--danger,#d64545)" : undefined }}>{v}</b>
                  </div>
                );
              })}
              <div className="det-row total"><span>Total</span><b className="mono">{s.total}</b></div>
            </div>
          </div>

          <div className="det-block">
            <h4>Publicado por canal</h4>
            <div className="det-rows">
              {CANALES.map((c) => {
                const v = s.por_canal[c.key];
                const over = c.key !== "ml_full" && (v ?? 0) > pool;
                return (
                  <div className="det-row" key={c.key}>
                    <span>{c.label}</span>
                    <b className="mono" style={{ color: over ? "var(--danger,#d64545)" : v == null ? "var(--ink-faint)" : undefined }}>
                      {v ?? "—"}{over ? " ⚠" : ""}
                    </b>
                  </div>
                );
              })}
              <div className="det-row total"><span>Pool físico (Flexit)</span><b className="mono">{pool}</b></div>
            </div>
            <p className="muted" style={{ fontSize: ".76rem", marginTop: 6 }}>
              ML Flex y Tienda Nube comparten el pool de Flexit. Si ofertan más que ese pool, hay riesgo de sobreventa.
            </p>
          </div>
        </div>

        <div className="det-block">
          <h4>Reposición</h4>
          <div className="between" style={{ gap: 12, flexWrap: "wrap" }}>
            <label className="field" style={{ margin: 0 }}>
              <span>Stock mínimo (avisa cuando el total baja de acá)</span>
              <input className="input" type="number" min={0} value={min}
                onChange={(e) => setMin(Math.max(0, Math.round(Number(e.target.value) || 0)))} style={{ width: 140 }} />
            </label>
            <button className="btn primary" disabled={!dirty || saving} onClick={guardar}>
              {saving ? "Guardando…" : "Guardar mínimo"}
            </button>
          </div>
          <p className="muted" style={{ fontSize: ".76rem", marginTop: 6 }}>
            Estado actual: <b>{s.estado === "ok" ? "OK" : s.estado === "reponer" ? "por reponer" : "sin stock"}</b>.
            {" "}Costo unitario: <b className="mono">${(s.costo || 0).toLocaleString("es-AR")}</b> · Valor en stock: <b className="mono">${valorCosto.toLocaleString("es-AR")}</b>.
          </p>
        </div>
      </div>
    </div>
  );
}
