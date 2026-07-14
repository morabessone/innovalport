import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import type { StockConsolidado } from "../lib/types.ts";

const DEPS = ["GEN", "FLX", "FULL", "OFI"];
const ESTADO_LABEL: Record<string, string> = { ok: "OK", reponer: "reponer", sin_stock: "sin stock" };

// Reconciliación físico ↔ publicado.
// Full: físico = publicado (ML administra). El pool compartido (total − Full)
// respalda ML Flex + Tienda Nube + Web. Sobreventa si Flex publica más que eso.
type Pub = "sincronizado" | "sobreventa" | "sin_publicar" | "na";
function reconciliar(s: StockConsolidado): Pub {
  const pubFull = s.por_canal.ml_full ?? 0;
  const pubFlex = s.por_canal.ml_flex ?? 0;
  const compartido = Math.max(0, s.total - pubFull);
  if (pubFull + pubFlex === 0) return s.total > 0 ? "sin_publicar" : "na";
  if (pubFlex > compartido) return "sobreventa";
  return "sincronizado";
}
const PUB_UI: Record<Pub, { label: string; cls: string }> = {
  sincronizado: { label: "✓ sincronizado", cls: "ok" },
  sobreventa: { label: "⚠ sobreventa", cls: "sin_stock" },
  sin_publicar: { label: "○ sin publicar", cls: "reponer" },
  na: { label: "—", cls: "neutral" },
};

export function Panel({ notify }: { notify: (m: string) => void }) {
  const [stock, setStock] = useState<StockConsolidado[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const [q, setQ] = useState("");
  const [estado, setEstado] = useState("todos");
  const [deposito, setDeposito] = useState("todos");
  const [pubFiltro, setPubFiltro] = useState("todos");
  const [verInactivos, setVerInactivos] = useState(false);
  const [soloProblemas, setSoloProblemas] = useState(false);
  const [trabajando, setTrabajando] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<string>("sku");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  function ordenar(key: string) {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(key === "sku" || key === "nombre" ? 1 : -1); }
  }
  const flechita = (key: string) => (sortKey === key ? (sortDir === 1 ? " ▲" : " ▼") : "");

  async function load() {
    setLoading(true);
    const [s, ls] = await Promise.all([api.stock(), api.lastSync()]);
    setStock(s); setLastSync(ls); setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function sync() {
    setSyncing(true);
    try {
      await Promise.all([api.syncNow(), api.syncCanales()]);
      await new Promise((r) => setTimeout(r, api.connected ? 4000 : 0));
      await load();
      notify(api.connected ? "Sincronizando stock y publicaciones…" : "Datos actualizados");
    } catch (e) {
      notify("No se pudo sincronizar: " + (e as Error).message);
    } finally { setSyncing(false); }
  }

  async function toggleBaja(p: StockConsolidado) {
    const dar = p.activo;
    if (dar && !confirm(`¿Dar de baja "${p.sku}"?`)) return;
    setTrabajando(p.producto_id);
    try { await api.bajaProducto(p.producto_id, !dar); await load(); notify(dar ? `${p.sku} dado de baja` : `${p.sku} reactivado`); }
    catch (e) { notify("Error: " + (e as Error).message); } finally { setTrabajando(null); }
  }

  const conReconc = useMemo(() => stock.map((s) => ({ s, pub: reconciliar(s) })), [stock]);

  function valorOrden({ s, pub }: { s: StockConsolidado; pub: Pub }): string | number {
    switch (sortKey) {
      case "sku": return s.sku.toLowerCase();
      case "nombre": return s.nombre.toLowerCase();
      case "total": return s.total;
      case "ml_full": return s.por_canal.ml_full ?? 0;
      case "ml_flex": return s.por_canal.ml_flex ?? 0;
      case "estado": return s.estado;
      case "pub": return pub;
      case "GEN": case "FLX": case "FULL": case "OFI": return s.por_deposito[sortKey] ?? 0;
      default: return s.sku.toLowerCase();
    }
  }

  const filtrado = useMemo(() => {
    const term = q.trim().toLowerCase();
    const out = conReconc.filter(({ s, pub }) => {
      if (!verInactivos && !s.activo) return false;
      if (term && !`${s.sku} ${s.nombre}`.toLowerCase().includes(term)) return false;
      if (estado !== "todos" && s.estado !== estado) return false;
      if (deposito !== "todos" && (s.por_deposito[deposito] ?? 0) <= 0) return false;
      if (pubFiltro !== "todos" && pub !== pubFiltro) return false;
      if (soloProblemas && !(pub === "sobreventa" || pub === "sin_publicar")) return false;
      return true;
    });
    out.sort((a, b) => {
      const va = valorOrden(a), vb = valorOrden(b);
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });
    return out;
  }, [conReconc, q, estado, deposito, pubFiltro, verInactivos, soloProblemas, sortKey, sortDir]);

  const activos = stock.filter((s) => s.activo);
  const totalUnidades = activos.reduce((a, s) => a + s.total, 0);
  const sobreventa = conReconc.filter(({ s, pub }) => s.activo && pub === "sobreventa").length;
  const sinPublicar = conReconc.filter(({ s, pub }) => s.activo && pub === "sin_publicar").length;

  return (
    <div className="stack">
      <div className="section-head">
        <div><span className="eyebrow">Panel</span><h2>Stock y publicaciones</h2></div>
        <div className="between" style={{ gap: 12 }}>
          <span className="muted">{lastSync ? "Actualizado " + new Date(lastSync).toLocaleString("es-AR") : "Sin sincronizar"}</span>
          <button className="btn" onClick={sync} disabled={syncing}>{syncing ? "Sincronizando…" : "↻ Sincronizar"}</button>
        </div>
      </div>

      <div className="tiles">
        <div className="tile"><b className="tnum">{activos.length}</b><span>Productos activos</span></div>
        <div className="tile okv"><b className="tnum">{totalUnidades}</b><span>Unidades en stock</span></div>
        <div className={"tile" + (sobreventa ? " alert" : "")}><b className="tnum">{sobreventa}</b><span>Riesgo de sobreventa</span></div>
        <div className={"tile" + (sinPublicar ? " warnv" : "")}><b className="tnum">{sinPublicar}</b><span>Con stock sin publicar</span></div>
      </div>

      <div className="filters">
        <input className="input grow" placeholder="Buscar por SKU o nombre…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" value={estado} onChange={(e) => setEstado(e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="ok">OK</option><option value="reponer">Por reponer</option><option value="sin_stock">Sin stock</option>
        </select>
        <select className="select" value={deposito} onChange={(e) => setDeposito(e.target.value)}>
          <option value="todos">Todos los depósitos</option>
          {DEPS.map((d) => <option key={d} value={d}>Con stock en {d}</option>)}
        </select>
        <select className="select" value={pubFiltro} onChange={(e) => setPubFiltro(e.target.value)}>
          <option value="todos">Toda publicación</option>
          <option value="sincronizado">✓ Sincronizado</option>
          <option value="sobreventa">⚠ Sobreventa</option>
          <option value="sin_publicar">○ Sin publicar</option>
          <option value="na">Sin datos de ML</option>
        </select>
        <label className="chk"><input type="checkbox" checked={soloProblemas} onChange={(e) => setSoloProblemas(e.target.checked)} /> Solo con problemas</label>
        <label className="chk"><input type="checkbox" checked={verInactivos} onChange={(e) => setVerInactivos(e.target.checked)} /> Ver inactivos</label>
      </div>

      <div className="card">
        <div className="scroll-x">
          <table className="tbl grouped">
            <thead>
              <tr className="grp">
                <th></th>
                <th className="gdep" colSpan={5}>Depósitos · físico</th>
                <th className="gpub divl" colSpan={2}>Publicado</th>
                <th></th><th></th>
              </tr>
              <tr>
                <th className="sortable" onClick={() => ordenar("sku")}>Producto{flechita("sku")}</th>
                {DEPS.map((d) => <th key={d} className="sortable" style={{ textAlign: "right" }} onClick={() => ordenar(d)}>{d}{flechita(d)}</th>)}
                <th className="sortable" style={{ textAlign: "right" }} onClick={() => ordenar("total")}>Total{flechita("total")}</th>
                <th className="sortable divl" style={{ textAlign: "right" }} onClick={() => ordenar("ml_full")}>ML Full{flechita("ml_full")}</th>
                <th className="sortable" style={{ textAlign: "right" }} onClick={() => ordenar("ml_flex")}>Propio{flechita("ml_flex")}</th>
                <th className="sortable" onClick={() => ordenar("pub")}>Publicación{flechita("pub")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={10} className="empty">Cargando…</td></tr>}
              {!loading && filtrado.length === 0 && <tr><td colSpan={10} className="empty">Sin resultados.</td></tr>}
              {filtrado.map(({ s, pub }) => (
                <tr key={s.producto_id} style={{ opacity: s.activo ? 1 : 0.55 }}>
                  <td className="sku">
                    {s.sku}
                    {!s.activo && <span className="badge neutral" style={{ marginLeft: 8 }}>baja</span>}
                    {s.estado !== "ok" && <span className={"badge " + s.estado} style={{ marginLeft: 8 }}>{ESTADO_LABEL[s.estado]}</span>}
                    <small>{s.nombre}</small>
                  </td>
                  {DEPS.map((d) => (
                    <td key={d} className="tnum" style={{ textAlign: "right", color: (s.por_deposito[d] ?? 0) === 0 ? "var(--ink-faint)" : undefined }}>{s.por_deposito[d] ?? 0}</td>
                  ))}
                  <td className="tnum mono" style={{ textAlign: "right", fontWeight: 700 }}>{s.total}</td>
                  <td className="tnum mono divl" style={{ textAlign: "right" }}>{s.por_canal.ml_full ?? 0}</td>
                  <td className="tnum mono" style={{ textAlign: "right" }}>{s.por_canal.ml_flex ?? 0}</td>
                  <td><span className={"badge " + PUB_UI[pub].cls}>{PUB_UI[pub].label}</span></td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn ghost btn-sm" disabled={trabajando === s.producto_id} onClick={() => toggleBaja(s)}>{s.activo ? "Baja" : "Reactivar"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted" style={{ fontSize: ".82rem" }}>
        <b>ML Full</b>: publicado en Mercado Libre Full (= físico Full, lo administra ML). <b>Propio</b>: publicado en ML Flex,
        que comparte pool con Tienda Nube y la Web. <b>⚠ Sobreventa</b> = Propio publica más que el stock compartido (total − Full).
      </p>
    </div>
  );
}
