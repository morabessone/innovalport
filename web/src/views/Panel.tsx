import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import type { StockConsolidado } from "../lib/types.ts";
import { ProductoDetalle } from "./ProductoDetalle.tsx";

// Depósitos físicos (Contabilium): Genpol, Full, Flexit, Oficina.
const DEPS: { code: string; label: string }[] = [
  { code: "GEN", label: "Genpol" },
  { code: "FULL", label: "Full" },
  { code: "FLX", label: "Flexit" },
  { code: "OFI", label: "Oficina" },
];
const ESTADO_LABEL: Record<string, string> = { ok: "OK", reponer: "reponer", sin_stock: "sin stock" };
const TIPO_LABEL: Record<string, string> = { C: "combo", V: "variante" };

// Reconciliación físico ↔ publicado.
//  · Full: bodega de Mercado Libre (exclusivo ML). Físico = publicado.
//  · Flexit: pool físico compartido que abastece ML Flex y Tienda Nube.
// Sobreventa: ML Flex o Tienda Nube ofertan más que el físico en Flexit.
type Pub = "sincronizado" | "sobreventa" | "desync" | "sin_publicar" | "na";
function reconciliar(s: StockConsolidado): Pub {
  const pool = s.por_deposito.FLX ?? 0;   // Flexit físico
  const pubFlex = s.por_canal.ml_flex ?? 0;
  const pubTN = s.por_canal.tn ?? 0;
  const pubFull = s.por_canal.ml_full ?? 0;
  if (pubFull + pubFlex + pubTN === 0) return s.total > 0 ? "sin_publicar" : "na";
  if (pubFlex > pool || pubTN > pool) return "sobreventa";
  if (pubFlex > 0 && pubTN > 0 && pubFlex !== pubTN) return "desync";
  return "sincronizado";
}
const PUB_UI: Record<Pub, { label: string; cls: string }> = {
  sincronizado: { label: "✓ sincronizado", cls: "ok" },
  sobreventa: { label: "⚠ sobreventa", cls: "sin_stock" },
  desync: { label: "≠ desincronizado", cls: "reponer" },
  sin_publicar: { label: "○ sin publicar", cls: "reponer" },
  na: { label: "—", cls: "neutral" },
};

export function Panel({ notify }: { notify: (m: string) => void }) {
  const [stock, setStock] = useState<StockConsolidado[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [sel, setSel] = useState<StockConsolidado | null>(null);

  const [q, setQ] = useState("");
  const [estado, setEstado] = useState("todos");
  const [deposito, setDeposito] = useState("todos");
  const [pubFiltro, setPubFiltro] = useState("todos");
  const [verInactivos, setVerInactivos] = useState(false);
  const [verCombos, setVerCombos] = useState(false);
  const [soloProblemas, setSoloProblemas] = useState(false);
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

  const conReconc = useMemo(() => stock.map((s) => ({ s, pub: reconciliar(s) })), [stock]);

  function valorOrden({ s, pub }: { s: StockConsolidado; pub: Pub }): string | number {
    switch (sortKey) {
      case "sku": return s.sku.toLowerCase();
      case "total": return s.total;
      case "ml_full": return s.por_canal.ml_full ?? 0;
      case "ml_flex": return s.por_canal.ml_flex ?? 0;
      case "tn": return s.por_canal.tn ?? 0;
      case "estado": return s.estado;
      case "pub": return pub;
      case "GEN": case "FLX": case "FULL": case "OFI": return s.por_deposito[sortKey] ?? 0;
      default: return s.sku.toLowerCase();
    }
  }

  const filtrado = useMemo(() => {
    const term = q.trim().toLowerCase();
    const out = conReconc.filter(({ s, pub }) => {
      if (!verCombos && s.tipo !== "P") return false;
      if (!verInactivos && !s.activo) return false;
      if (term && !`${s.sku} ${s.nombre}`.toLowerCase().includes(term)) return false;
      if (estado !== "todos" && s.estado !== estado) return false;
      if (deposito !== "todos" && (s.por_deposito[deposito] ?? 0) <= 0) return false;
      if (pubFiltro !== "todos" && pub !== pubFiltro) return false;
      if (soloProblemas && !(pub === "sobreventa" || pub === "desync" || pub === "sin_publicar")) return false;
      return true;
    });
    out.sort((a, b) => {
      const va = valorOrden(a), vb = valorOrden(b);
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });
    return out;
  }, [conReconc, q, estado, deposito, pubFiltro, verInactivos, verCombos, soloProblemas, sortKey, sortDir]);

  const base = stock.filter((s) => s.tipo === "P" && s.activo);
  const totalUnidades = base.reduce((a, s) => a + Math.max(0, s.total), 0);
  const sobreventa = conReconc.filter(({ s, pub }) => s.activo && s.tipo === "P" && pub === "sobreventa").length;
  const porReponer = base.filter((s) => s.estado === "reponer" || s.estado === "sin_stock").length;

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
        <div className="tile"><b className="tnum">{base.length}</b><span>Productos activos</span></div>
        <div className="tile okv"><b className="tnum">{totalUnidades}</b><span>Unidades en stock</span></div>
        <div className={"tile" + (sobreventa ? " alert" : "")}><b className="tnum">{sobreventa}</b><span>Riesgo de sobreventa</span></div>
        <div className={"tile" + (porReponer ? " warnv" : "")}><b className="tnum">{porReponer}</b><span>Por reponer</span></div>
      </div>

      <div className="filters">
        <input className="input grow" placeholder="Buscar por SKU o nombre…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" value={estado} onChange={(e) => setEstado(e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="ok">OK</option><option value="reponer">Por reponer</option><option value="sin_stock">Sin stock</option>
        </select>
        <select className="select" value={deposito} onChange={(e) => setDeposito(e.target.value)}>
          <option value="todos">Todos los depósitos</option>
          {DEPS.map((d) => <option key={d.code} value={d.code}>Con stock en {d.label}</option>)}
        </select>
        <select className="select" value={pubFiltro} onChange={(e) => setPubFiltro(e.target.value)}>
          <option value="todos">Toda publicación</option>
          <option value="sincronizado">✓ Sincronizado</option>
          <option value="sobreventa">⚠ Sobreventa</option>
          <option value="desync">≠ Desincronizado</option>
          <option value="sin_publicar">○ Sin publicar</option>
          <option value="na">Sin datos</option>
        </select>
        <label className="chk"><input type="checkbox" checked={soloProblemas} onChange={(e) => setSoloProblemas(e.target.checked)} /> Solo con problemas</label>
        <label className="chk"><input type="checkbox" checked={verCombos} onChange={(e) => setVerCombos(e.target.checked)} /> Ver combos/variantes</label>
        <label className="chk"><input type="checkbox" checked={verInactivos} onChange={(e) => setVerInactivos(e.target.checked)} /> Ver inactivos</label>
      </div>

      <div className="card">
        <div className="scroll-x">
          <table className="tbl grouped">
            <thead>
              <tr className="grp">
                <th></th>
                <th className="gdep" colSpan={5}>Depósitos · físico</th>
                <th className="gpub divl" colSpan={3}>Publicado por canal</th>
                <th></th>
              </tr>
              <tr>
                <th className="sortable" onClick={() => ordenar("sku")}>Producto{flechita("sku")}</th>
                {DEPS.map((d) => <th key={d.code} className="sortable" style={{ textAlign: "right" }} onClick={() => ordenar(d.code)}>{d.label}{flechita(d.code)}</th>)}
                <th className="sortable" style={{ textAlign: "right" }} onClick={() => ordenar("total")}>Total{flechita("total")}</th>
                <th className="sortable divl" style={{ textAlign: "right" }} onClick={() => ordenar("ml_full")}>ML Full{flechita("ml_full")}</th>
                <th className="sortable" style={{ textAlign: "right" }} onClick={() => ordenar("ml_flex")}>ML Flex{flechita("ml_flex")}</th>
                <th className="sortable" style={{ textAlign: "right" }} onClick={() => ordenar("tn")}>T. Nube{flechita("tn")}</th>
                <th className="sortable" onClick={() => ordenar("pub")}>Publicación{flechita("pub")}</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={10} className="empty">Cargando…</td></tr>}
              {!loading && filtrado.length === 0 && <tr><td colSpan={10} className="empty">Sin resultados.</td></tr>}
              {filtrado.map(({ s, pub }) => {
                const pool = s.por_deposito.FLX ?? 0;
                return (
                  <tr key={s.producto_id} className="rowlink" style={{ opacity: s.activo ? 1 : 0.55 }} onClick={() => setSel(s)}>
                    <td className="sku">
                      {s.sku}
                      {s.tipo !== "P" && <span className="badge neutral" style={{ marginLeft: 8 }}>{TIPO_LABEL[s.tipo]}</span>}
                      {!s.activo && <span className="badge neutral" style={{ marginLeft: 8 }}>baja</span>}
                      {s.estado !== "ok" && <span className={"badge " + s.estado} style={{ marginLeft: 8 }}>{ESTADO_LABEL[s.estado]}</span>}
                      <small>{s.nombre}</small>
                    </td>
                    {DEPS.map((d) => {
                      const v = s.por_deposito[d.code] ?? 0;
                      return <td key={d.code} className="tnum" style={{ textAlign: "right", color: v < 0 ? "var(--danger, #d64545)" : v === 0 ? "var(--ink-faint)" : undefined }}>{v}</td>;
                    })}
                    <td className="tnum mono" style={{ textAlign: "right", fontWeight: 700 }}>{s.total}</td>
                    <td className="tnum mono divl" style={{ textAlign: "right", color: s.por_canal.ml_full == null ? "var(--ink-faint)" : undefined }}>{s.por_canal.ml_full ?? "—"}</td>
                    <td className="tnum mono" style={{ textAlign: "right", color: (s.por_canal.ml_flex ?? 0) > pool ? "var(--danger, #d64545)" : (s.por_canal.ml_flex == null ? "var(--ink-faint)" : undefined), fontWeight: (s.por_canal.ml_flex ?? 0) > pool ? 700 : undefined }}>{s.por_canal.ml_flex ?? "—"}</td>
                    <td className="tnum mono" style={{ textAlign: "right", color: (s.por_canal.tn ?? 0) > pool ? "var(--danger, #d64545)" : (s.por_canal.tn == null ? "var(--ink-faint)" : undefined), fontWeight: (s.por_canal.tn ?? 0) > pool ? 700 : undefined }}>{s.por_canal.tn ?? "—"}</td>
                    <td><span className={"badge " + PUB_UI[pub].cls}>{PUB_UI[pub].label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted" style={{ fontSize: ".82rem" }}>
        <b>Depósitos:</b> Genpol (bulk) · Full (bodega ML) · Flexit (pool físico de ML Flex + Tienda Nube) · Oficina.
        <b> ML Flex</b> y <b>T. Nube</b> se abastecen de Flexit. <b>⚠ Sobreventa</b> = un canal oferta más que el físico en
        Flexit (celda en rojo). Clic en un producto para ver el detalle y setear su mínimo.
      </p>

      {sel && (
        <ProductoDetalle
          producto={sel}
          onClose={() => setSel(null)}
          onSaved={async () => { await load(); }}
          notify={notify}
        />
      )}
    </div>
  );
}
