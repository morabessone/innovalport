import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { StockConsolidado } from "../lib/types.ts";

const DEPS = ["GEN", "FLX", "FULL", "OFI"];
const ESTADO_LABEL: Record<string, string> = { ok: "OK", reponer: "reponer", sin_stock: "sin stock" };

export function Panel({ notify }: { notify: (m: string) => void }) {
  const [stock, setStock] = useState<StockConsolidado[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  async function load() {
    setLoading(true);
    const [s, ls] = await Promise.all([api.stock(), api.lastSync()]);
    setStock(s);
    setLastSync(ls);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function sync() {
    setSyncing(true);
    try {
      await api.syncNow();
      await load();
      notify(api.connected ? "Stock sincronizado con Contabilium" : "Datos de demo actualizados");
    } catch (e) {
      notify("No se pudo sincronizar: " + (e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  const totalUnidades = stock.reduce((a, s) => a + s.total, 0);
  const sinStock = stock.filter((s) => s.estado === "sin_stock").length;
  const reponer = stock.filter((s) => s.estado === "reponer").length;

  return (
    <div className="stack">
      <div className="section-head">
        <div>
          <span className="eyebrow">Panel</span>
          <h2>Stock consolidado</h2>
        </div>
        <div className="between" style={{ gap: 12 }}>
          <span className="muted">
            {lastSync ? "Actualizado " + new Date(lastSync).toLocaleString("es-AR") : "Sin sincronizar"}
          </span>
          <button className="btn" onClick={sync} disabled={syncing}>
            {syncing ? "Sincronizando…" : "↻ Sincronizar"}
          </button>
        </div>
      </div>

      <div className="tiles">
        <div className="tile"><b className="tnum">{stock.length}</b><span>Productos activos</span></div>
        <div className="tile okv"><b className="tnum">{totalUnidades}</b><span>Unidades en stock</span></div>
        <div className={"tile" + (reponer ? " warnv" : "")}><b className="tnum">{reponer}</b><span>Por reponer</span></div>
        <div className={"tile" + (sinStock ? " alert" : "")}><b className="tnum">{sinStock}</b><span>Sin stock</span></div>
      </div>

      {sinStock + reponer > 0 && (
        <div className="pill-note">
          ⚠ Hay {sinStock + reponer} producto(s) que necesitan reposición. Revisá los marcados como
          «sin stock» o «reponer» antes de que se corte una publicación.
        </div>
      )}

      <div className="card">
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>Producto</th>
                {DEPS.map((d) => <th key={d} style={{ textAlign: "right" }}>{d}</th>)}
                <th style={{ textAlign: "right" }}>Total</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="empty">Cargando…</td></tr>}
              {!loading && stock.length === 0 && <tr><td colSpan={7} className="empty">No hay productos todavía. Sincronizá con Contabilium.</td></tr>}
              {stock.map((s) => (
                <tr key={s.producto_id}>
                  <td className="sku">{s.sku}<small>{s.nombre}</small></td>
                  {DEPS.map((d) => (
                    <td key={d} className="tnum" style={{ textAlign: "right", color: (s.por_deposito[d] ?? 0) === 0 ? "var(--ink-faint)" : undefined }}>
                      {s.por_deposito[d] ?? 0}
                    </td>
                  ))}
                  <td className="tnum mono" style={{ textAlign: "right", fontWeight: 700 }}>{s.total}</td>
                  <td><span className={"badge " + s.estado}>{ESTADO_LABEL[s.estado]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
