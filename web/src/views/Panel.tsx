import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import type { StockConsolidado } from "../lib/types.ts";
import { ProductoDetalle } from "./ProductoDetalle.tsx";

const ESTADO_LABEL: Record<string, string> = { ok: "OK", reponer: "reponer", sin_stock: "sin stock" };
const TIPO_LABEL: Record<string, string> = { C: "combo", V: "variante" };

// Columnas reagrupadas por depósito ↔ canal de venta:
//   Genpol · [Full ↔ ML Full] · [Flexit ↔ ML Flex / Tienda Nube] · Oficina
type Col = { key: string; kind: "dep" | "canal"; label: string };
const COLS: Col[] = [
  { key: "GEN", kind: "dep", label: "Genpol" },
  { key: "FULL", kind: "dep", label: "Full" },
  { key: "ml_full", kind: "canal", label: "ML Full" },
  { key: "FLX", kind: "dep", label: "Flexit" },
  { key: "ml_flex", kind: "canal", label: "ML Flex" },
  { key: "tn", kind: "canal", label: "T. Nube" },
  { key: "OFI", kind: "dep", label: "Oficina" },
];

// Reconciliación físico ↔ publicado.
//  · Full: bodega de Mercado Libre. · Flexit: pool físico que abastece ML Flex + Tienda Nube.
// Sobreventa: ML Flex o Tienda Nube ofertan más que el físico en Flexit.
type Pub = "sincronizado" | "sobreventa" | "desync" | "sin_publicar" | "na";
function reconciliar(s: StockConsolidado): Pub {
  const pool = s.por_deposito.FLX ?? 0;
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

// ---- Filtro multi-selección (dropdown con checkboxes) ----
function MultiSelect({ label, options, sel, setSel }: {
  label: string; options: { v: string; t: string }[]; sel: Set<string>; setSel: (s: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const n = sel.size;
  function toggle(v: string) { const s = new Set(sel); s.has(v) ? s.delete(v) : s.add(v); setSel(s); }
  return (
    <div className="ms">
      <button className={"select ms-btn" + (n ? " on" : "")} onClick={() => setOpen((o) => !o)}>
        {label}{n ? ` · ${n}` : ""} <span className="ms-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="ms-back" onClick={() => setOpen(false)} />
          <div className="ms-pop">
            <div className="ms-head"><span>{label}</span>{n > 0 && <button className="ms-clear" onClick={() => setSel(new Set())}>limpiar</button>}</div>
            {options.map((o) => (
              <label key={o.v} className="ms-opt">
                <input type="checkbox" checked={sel.has(o.v)} onChange={() => toggle(o.v)} /> {o.t}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function Panel({ notify }: { notify: (m: string) => void }) {
  const [stock, setStock] = useState<StockConsolidado[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [sel, setSel] = useState<StockConsolidado | null>(null);

  const [q, setQ] = useState("");
  const [estadoSel, setEstadoSel] = useState<Set<string>>(new Set());
  const [depSel, setDepSel] = useState<Set<string>>(new Set());
  const [pubSel, setPubSel] = useState<Set<string>>(new Set());
  const [verInactivos, setVerInactivos] = useState(false);
  const [verCombos, setVerCombos] = useState(false);
  const [soloProblemas, setSoloProblemas] = useState(false);
  const [sortKey, setSortKey] = useState<string>("sku");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  function ordenar(key: string) {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(key === "sku" ? 1 : -1); }
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

  function valor(s: StockConsolidado, key: string): number | string {
    if (key === "sku") return s.sku.toLowerCase();
    if (key === "total") return s.total;
    if (["GEN", "FULL", "FLX", "OFI"].includes(key)) return s.por_deposito[key] ?? 0;
    return s.por_canal[key] ?? 0;
  }
  function valorOrden({ s, pub }: { s: StockConsolidado; pub: Pub }): string | number {
    if (sortKey === "pub") return pub;
    if (sortKey === "estado") return s.estado;
    return valor(s, sortKey);
  }

  const filtrado = useMemo(() => {
    const term = q.trim().toLowerCase();
    const out = conReconc.filter(({ s, pub }) => {
      if (!verCombos && s.tipo !== "P") return false;
      if (!verInactivos && !s.activo) return false;
      if (term && !`${s.sku} ${s.nombre}`.toLowerCase().includes(term)) return false;
      if (estadoSel.size && !estadoSel.has(s.estado)) return false;
      if (depSel.size && ![...depSel].some((d) => (s.por_deposito[d] ?? 0) > 0)) return false;
      if (pubSel.size && !pubSel.has(pub)) return false;
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
  }, [conReconc, q, estadoSel, depSel, pubSel, verInactivos, verCombos, soloProblemas, sortKey, sortDir]);

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
        <MultiSelect label="Estado" sel={estadoSel} setSel={setEstadoSel}
          options={[{ v: "ok", t: "OK" }, { v: "reponer", t: "Por reponer" }, { v: "sin_stock", t: "Sin stock" }]} />
        <MultiSelect label="Depósito" sel={depSel} setSel={setDepSel}
          options={[{ v: "GEN", t: "Genpol" }, { v: "FULL", t: "Full" }, { v: "FLX", t: "Flexit" }, { v: "OFI", t: "Oficina" }]} />
        <MultiSelect label="Publicación" sel={pubSel} setSel={setPubSel}
          options={[{ v: "sincronizado", t: "✓ Sincronizado" }, { v: "sobreventa", t: "⚠ Sobreventa" }, { v: "desync", t: "≠ Desincronizado" }, { v: "sin_publicar", t: "○ Sin publicar" }, { v: "na", t: "Sin datos" }]} />
        <label className="chk"><input type="checkbox" checked={soloProblemas} onChange={(e) => setSoloProblemas(e.target.checked)} /> Solo con problemas</label>
        <label className="chk"><input type="checkbox" checked={verCombos} onChange={(e) => setVerCombos(e.target.checked)} /> Ver combos/variantes</label>
        <label className="chk"><input type="checkbox" checked={verInactivos} onChange={(e) => setVerInactivos(e.target.checked)} /> Ver inactivos</label>
      </div>

      <div className="card">
        <div className="tbl-scroll">
          <table className="tbl grouped stickyt">
            <thead>
              <tr className="grp">
                <th className="c0"></th>
                <th className="gdep">Genpol</th>
                <th className="gpub divl" colSpan={2}>Mercado Libre Full</th>
                <th className="gpub divl" colSpan={3}>Flexit → ML Flex / Tienda Nube</th>
                <th className="gdep divl">Oficina</th>
                <th className="divl"></th>
                <th></th>
              </tr>
              <tr className="cols">
                <th className="c0 sortable" onClick={() => ordenar("sku")}>Producto{flechita("sku")}</th>
                {COLS.map((c, i) => (
                  <th key={c.key} className={"sortable" + ([1, 3, 6].includes(i) ? " divl" : "") + (c.kind === "canal" ? " canalh" : "")}
                    style={{ textAlign: "right" }} onClick={() => ordenar(c.key)}>{c.label}{flechita(c.key)}</th>
                ))}
                <th className="sortable divl" style={{ textAlign: "right" }} onClick={() => ordenar("total")}>Total{flechita("total")}</th>
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
                    <td className="sku c0">
                      {s.sku}
                      {s.tipo !== "P" && <span className="badge neutral" style={{ marginLeft: 8 }}>{TIPO_LABEL[s.tipo]}</span>}
                      {!s.activo && <span className="badge neutral" style={{ marginLeft: 8 }}>baja</span>}
                      {s.estado !== "ok" && <span className={"badge " + s.estado} style={{ marginLeft: 8 }}>{ESTADO_LABEL[s.estado]}</span>}
                      <small>{s.nombre}</small>
                    </td>
                    {COLS.map((c, i) => {
                      const divl = [1, 3, 6].includes(i) ? " divl" : "";
                      if (c.kind === "dep") {
                        const v = s.por_deposito[c.key] ?? 0;
                        return <td key={c.key} className={"tnum" + divl} style={{ textAlign: "right", color: v < 0 ? "var(--danger,#d64545)" : v === 0 ? "var(--ink-faint)" : undefined }}>{v}</td>;
                      }
                      const v = s.por_canal[c.key];
                      const over = c.key !== "ml_full" && (v ?? 0) > pool;
                      return <td key={c.key} className={"tnum mono canalc" + divl}
                        style={{ textAlign: "right", fontWeight: over ? 700 : undefined, color: over ? "var(--danger,#d64545)" : (v == null ? "var(--ink-faint)" : undefined) }}>{v ?? "—"}</td>;
                    })}
                    <td className="tnum mono divl" style={{ textAlign: "right", fontWeight: 700 }}>{s.total}</td>
                    <td><span className={"badge " + PUB_UI[pub].cls}>{PUB_UI[pub].label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted" style={{ fontSize: ".82rem" }}>
        Cada depósito se muestra con su canal de venta: <b>Full</b> abastece <b>ML Full</b>; <b>Flexit</b> es el pool que
        abastece <b>ML Flex</b> y <b>Tienda Nube</b>. <b>⚠ Sobreventa</b> = un canal oferta más que el físico en Flexit (celda en rojo).
        Clic en un producto para ver el detalle y setear su mínimo.
      </p>

      {sel && (
        <ProductoDetalle producto={sel} onClose={() => setSel(null)} onSaved={async () => { await load(); }} notify={notify} />
      )}
    </div>
  );
}
