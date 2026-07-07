import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import type { StockConsolidado } from "../lib/types.ts";

const DEPS = ["GEN", "FLX", "FULL", "OFI"];
const ESTADO_LABEL: Record<string, string> = { ok: "OK", reponer: "reponer", sin_stock: "sin stock" };

export function Panel({ notify }: { notify: (m: string) => void }) {
  const [stock, setStock] = useState<StockConsolidado[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // filtros
  const [q, setQ] = useState("");
  const [estado, setEstado] = useState("todos");
  const [deposito, setDeposito] = useState("todos");
  const [verInactivos, setVerInactivos] = useState(false);
  const [trabajando, setTrabajando] = useState<string | null>(null);

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
      // dar tiempo a la sync (corre en background) y refrescar
      await new Promise((r) => setTimeout(r, api.connected ? 3000 : 0));
      await load();
      notify(api.connected ? "Sincronizando con Contabilium…" : "Datos actualizados");
    } catch (e) {
      notify("No se pudo sincronizar: " + (e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  async function toggleBaja(p: StockConsolidado) {
    const dar = p.activo;
    if (dar && !confirm(`¿Dar de baja "${p.sku}"? Deja de figurar como producto activo.`)) return;
    setTrabajando(p.producto_id);
    try {
      await api.bajaProducto(p.producto_id, !dar);
      await load();
      notify(dar ? `${p.sku} dado de baja` : `${p.sku} reactivado`);
    } catch (e) {
      notify("Error: " + (e as Error).message);
    } finally {
      setTrabajando(null);
    }
  }

  const filtrado = useMemo(() => {
    const term = q.trim().toLowerCase();
    return stock.filter((s) => {
      if (!verInactivos && !s.activo) return false;
      if (term && !(`${s.sku} ${s.nombre}`.toLowerCase().includes(term))) return false;
      if (estado !== "todos" && s.estado !== estado) return false;
      if (deposito !== "todos" && (s.por_deposito[deposito] ?? 0) <= 0) return false;
      return true;
    });
  }, [stock, q, estado, deposito, verInactivos]);

  const activos = stock.filter((s) => s.activo);
  const totalUnidades = activos.reduce((a, s) => a + s.total, 0);
  const sinStock = activos.filter((s) => s.estado === "sin_stock").length;
  const reponer = activos.filter((s) => s.estado === "reponer").length;

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
        <div className="tile"><b className="tnum">{activos.length}</b><span>Productos activos</span></div>
        <div className="tile okv"><b className="tnum">{totalUnidades}</b><span>Unidades en stock</span></div>
        <div className={"tile" + (reponer ? " warnv" : "")}><b className="tnum">{reponer}</b><span>Por reponer</span></div>
        <div className={"tile" + (sinStock ? " alert" : "")}><b className="tnum">{sinStock}</b><span>Sin stock</span></div>
      </div>

      <div className="filters">
        <input className="input grow" placeholder="Buscar por SKU o nombre…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" value={estado} onChange={(e) => setEstado(e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="ok">OK</option>
          <option value="reponer">Por reponer</option>
          <option value="sin_stock">Sin stock</option>
        </select>
        <select className="select" value={deposito} onChange={(e) => setDeposito(e.target.value)}>
          <option value="todos">Todos los depósitos</option>
          {DEPS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <label className="chk">
          <input type="checkbox" checked={verInactivos} onChange={(e) => setVerInactivos(e.target.checked)} />
          Ver inactivos
        </label>
      </div>

      <div className="card">
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>Producto</th>
                {DEPS.map((d) => <th key={d} style={{ textAlign: "right" }}>{d}</th>)}
                <th style={{ textAlign: "right" }}>Total</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={8} className="empty">Cargando…</td></tr>}
              {!loading && filtrado.length === 0 && <tr><td colSpan={8} className="empty">Sin resultados.</td></tr>}
              {filtrado.map((s) => (
                <tr key={s.producto_id} style={{ opacity: s.activo ? 1 : 0.55 }}>
                  <td className="sku">
                    {s.sku}{!s.activo && <span className="badge neutral" style={{ marginLeft: 8 }}>baja</span>}
                    <small>{s.nombre}</small>
                  </td>
                  {DEPS.map((d) => (
                    <td key={d} className="tnum" style={{ textAlign: "right", color: (s.por_deposito[d] ?? 0) === 0 ? "var(--ink-faint)" : undefined }}>
                      {s.por_deposito[d] ?? 0}
                    </td>
                  ))}
                  <td className="tnum mono" style={{ textAlign: "right", fontWeight: 700 }}>{s.total}</td>
                  <td><span className={"badge " + s.estado}>{ESTADO_LABEL[s.estado]}</span></td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn ghost btn-sm" disabled={trabajando === s.producto_id} onClick={() => toggleBaja(s)}>
                      {s.activo ? "Dar de baja" : "Reactivar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted" style={{ fontSize: ".82rem" }}>
        Contabilium define el stock <b>total</b> de cada producto. El reparto por depósito lo maneja el
        Centro de Stock con los movimientos; lo no asignado se cuenta en <b>Oficina (OFI)</b>.
      </p>
    </div>
  );
}
