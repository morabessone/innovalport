import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import type { Deposito, Devolucion, DevolucionItem, StockConsolidado } from "../lib/types.ts";

const DEST_NO_APTA = [
  { v: "tirar", l: "Tirar" },
  { v: "outlet", l: "Outlet" },
  { v: "repuesto", l: "Repuesto" },
];

// Etiqueta del depósito de retiro a partir del código.
const RETIRO_LABEL: Record<string, string> = { GEN: "Genpol", FLX: "Flexit" };

export function Devoluciones({ notify }: { notify: (m: string) => void }) {
  const [deps, setDeps] = useState<Deposito[]>([]);
  const [prods, setProds] = useState<StockConsolidado[]>([]);
  const [lista, setLista] = useState<Devolucion[]>([]);
  const [saving, setSaving] = useState(false);
  const [detalle, setDetalle] = useState<Devolucion | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  async function load() {
    const [d, p, l] = await Promise.all([api.depositos(), api.stock(), api.devoluciones()]);
    setDeps(d); setProds(p); setLista(l);
    if (detalle) setDetalle(l.find((x) => x.id === detalle.id) ?? null);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const depCode = (id: string | null) => deps.find((d) => d.id === id)?.codigo ?? null;
  const skuNombre = (sku: string | null) => prods.find((p) => (p.sku ?? "").toLowerCase() === (sku ?? "").toLowerCase())?.nombre;

  const enProceso = lista.filter((d) => d.estado === "en_proceso");
  const porRetirar = lista.filter((d) => d.estado === "por_retirar");
  const enOficina = lista.filter((d) => d.estado === "en_oficina");
  const resueltas = lista.filter((d) => ["apta", "no_apta", "parcial"].includes(d.estado));

  async function act(fn: () => Promise<unknown>, ok: string) {
    setSaving(true);
    try { await fn(); await load(); notify(ok); }
    catch (e) { notify("Error: " + (e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <div className="stack">
      <div className="section-head">
        <div><span className="eyebrow">Devoluciones</span><h2>Circuito de devoluciones</h2></div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="muted">{enProceso.length + porRetirar.length + enOficina.length} activa(s)</span>
          <button className="btn ghost btn-sm" onClick={() => setManualOpen((v) => !v)}>
            {manualOpen ? "Cerrar" : "+ Cargar manual (T. Nube)"}
          </button>
        </div>
      </div>

      {manualOpen && (
        <CargaManual prods={prods} saving={saving} notify={notify}
          onDone={async () => { setManualOpen(false); await load(); }} />
      )}

      {/* Kanban de 4 etapas */}
      <div className="kanban k4">
        {/* 1 · En proceso (vienen de ML por API) */}
        <div className="kb-col">
          <div className="kb-head"><span>En proceso</span><span className="kb-count">{enProceso.length}</span></div>
          <p className="kb-hint">Devoluciones abiertas en Mercado Libre. Todavía en tránsito.</p>
          {enProceso.length === 0 && <p className="kb-empty">—</p>}
          {enProceso.map((d) => (
            <DevCard key={d.id} d={d} skuNombre={skuNombre} depCode={depCode}>
              <button className="btn ghost btn-sm" disabled={saving} onClick={() => setDetalle(d)}>Ver SKUs</button>
            </DevCard>
          ))}
        </div>

        {/* 2 · Por retirar */}
        <div className="kb-col">
          <div className="kb-head"><span>Por retirar</span><span className="kb-count">{porRetirar.length}</span></div>
          <p className="kb-hint">ML marcó entregado. Clasificá el depósito y generá el remito.</p>
          {porRetirar.length === 0 && <p className="kb-empty">—</p>}
          {porRetirar.map((d) => (
            <DevCard key={d.id} d={d} skuNombre={skuNombre} depCode={depCode}>
              <ClasificarBar d={d} depCode={depCode} saving={saving}
                onClasificar={(c) => act(() => api.clasificarDevolucion(d.id, c), `Clasificada · retirar de ${RETIRO_LABEL[c]}`)}
                onRemito={() => act(() => api.generarRemitoDevolucion(d.id), "Remito de retiro generado · pasó a Oficina")} />
              <button className="btn linky btn-sm" onClick={() => setDetalle(d)}>ver SKUs</button>
            </DevCard>
          ))}
        </div>

        {/* 3 · En oficina */}
        <div className="kb-col">
          <div className="kb-head"><span>En oficina · revisar</span><span className="kb-count">{enOficina.length}</span></div>
          <p className="kb-hint">Mercadería retirada. Marcá cada SKU: apto vuelve al stock, no apto es baja.</p>
          {enOficina.length === 0 && <p className="kb-empty">—</p>}
          {enOficina.map((d) => (
            <DevCard key={d.id} d={d} skuNombre={skuNombre} depCode={depCode}>
              <div className="between" style={{ marginTop: 4 }}>
                <span className="muted">{(d.items ?? []).filter((i) => i.apta == null).length} sin decidir</span>
                <button className="btn primary btn-sm" onClick={() => setDetalle(d)}>Revisar SKUs</button>
              </div>
            </DevCard>
          ))}
        </div>

        {/* 4 · Resueltas */}
        <div className="kb-col">
          <div className="kb-head"><span>Resueltas</span><span className="kb-count">{resueltas.length}</span></div>
          {resueltas.length === 0 && <p className="kb-empty">—</p>}
          {resueltas.map((d) => (
            <DevCard key={d.id} d={d} skuNombre={skuNombre} depCode={depCode}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
                {d.estado === "apta" && <span className="badge ok">Apta · reingresada</span>}
                {d.estado === "no_apta" && <span className="badge sin_stock">No apta · baja</span>}
                {d.estado === "parcial" && <span className="badge neutral">Parcial</span>}
                {d.valor_perdida != null && Number(d.valor_perdida) > 0 &&
                  <span className="muted mono">−${Number(d.valor_perdida).toLocaleString("es-AR")}</span>}
                <button className="btn linky btn-sm" onClick={() => setDetalle(d)}>detalle</button>
              </div>
            </DevCard>
          ))}
        </div>
      </div>

      {detalle && (
        <DetalleModal d={detalle} deps={deps} prods={prods} saving={saving} depCode={depCode} skuNombre={skuNombre}
          onClose={() => setDetalle(null)}
          onDecidir={(item_id, apta, opts) => act(() => api.decidirItemDevolucion({ item_id, apta, ...opts }), apta ? "SKU apto · reingresado al stock" : "SKU dado de baja")} />
      )}
    </div>
  );
}

// ---- Tarjeta de devolución ------------------------------------------------
function DevCard({ d, children, skuNombre, depCode }: {
  d: Devolucion; children?: React.ReactNode;
  skuNombre: (s: string | null) => string | undefined; depCode: (id: string | null) => string | null;
}) {
  const items = d.items ?? [];
  const retiro = depCode(d.deposito_retiro_id);
  return (
    <div className="kb-card">
      <div className="between">
        <span className="badge neutral">{d.canal ?? "—"} · {d.cantidad}u</span>
        <span className="muted mono" style={{ fontSize: ".72rem" }}>
          {d.origen === "ml_api" ? "ML API" : "manual"}{d.venta_ref ? " · " + d.venta_ref : ""}
        </span>
      </div>
      {retiro && <div className="dev-retiro">retira de <b>{RETIRO_LABEL[retiro] ?? retiro}</b></div>}
      <ul className="dev-skus">
        {items.length === 0 && <li className="muted">sin SKUs informados</li>}
        {items.map((it) => (
          <li key={it.id}>
            <span className="mono">{it.sku ?? "—"}</span>
            <span className="muted"> ×{it.cantidad}{skuNombre(it.sku) ? " · " + skuNombre(it.sku) : ""}</span>
            {it.apta === true && <span className="badge ok tiny">apta</span>}
            {it.apta === false && <span className="badge sin_stock tiny">baja</span>}
          </li>
        ))}
      </ul>
      {d.motivo && <p className="kb-motivo">{d.motivo}</p>}
      {children}
    </div>
  );
}

// ---- Barra de clasificación + generar remito ------------------------------
function ClasificarBar({ d, depCode, saving, onClasificar, onRemito }: {
  d: Devolucion; depCode: (id: string | null) => string | null; saving: boolean;
  onClasificar: (c: "GEN" | "FLX") => void; onRemito: () => void;
}) {
  const clasif = depCode(d.deposito_retiro_id);
  return (
    <div className="stack-xs" style={{ marginTop: 6 }}>
      <div className="segbar">
        <span className="muted">Retirar de:</span>
        <button className={"seg" + (clasif === "GEN" ? " on" : "")} disabled={saving} onClick={() => onClasificar("GEN")}>Genpol</button>
        <button className={"seg" + (clasif === "FLX" ? " on" : "")} disabled={saving} onClick={() => onClasificar("FLX")}>Flexit</button>
      </div>
      <button className="btn primary btn-sm" disabled={saving || !clasif} onClick={onRemito}
        title={!clasif ? "Clasificá primero el depósito" : ""}>Generar remito</button>
    </div>
  );
}

// ---- Modal de detalle (decisión por SKU) ----------------------------------
function DetalleModal({ d, deps, saving, depCode, skuNombre, onClose, onDecidir }: {
  d: Devolucion; deps: Deposito[]; prods: StockConsolidado[]; saving: boolean;
  depCode: (id: string | null) => string | null;
  skuNombre: (s: string | null) => string | undefined;
  onClose: () => void;
  onDecidir: (item_id: string, apta: boolean, opts: { deposito_destino_id?: string; destino_no_apta?: string }) => void;
}) {
  const items = d.items ?? [];
  const decidible = d.estado === "en_oficina";
  const retiro = depCode(d.deposito_retiro_id);
  const genId = deps.find((x) => x.codigo === "GEN")?.id;
  const flxId = deps.find((x) => x.codigo === "FLX")?.id;
  const ofiId = deps.find((x) => x.codigo === "OFI")?.id;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <div>
            <span className="eyebrow">Devolución {d.origen === "ml_api" ? "· Mercado Libre" : "· manual"}</span>
            <h3 style={{ margin: "2px 0" }}>{d.canal ?? "—"} · {d.venta_ref ?? "sin nº de venta"}</h3>
          </div>
          <button className="btn ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        {retiro && <p className="muted">Retiro desde <b>{RETIRO_LABEL[retiro] ?? retiro}</b> → Oficina</p>}
        {d.motivo && <p className="kb-motivo">{d.motivo}</p>}

        <table className="tbl" style={{ marginTop: 10 }}>
          <thead><tr><th>SKU</th><th>Cant.</th><th>Estado</th><th style={{ textAlign: "right" }}>Decisión</th></tr></thead>
          <tbody>
            {items.map((it) => (
              <ItemRow key={it.id} it={it} nombre={skuNombre(it.sku)} decidible={decidible} saving={saving}
                genId={genId} flxId={flxId} ofiId={ofiId}
                onDecidir={onDecidir} />
            ))}
            {items.length === 0 && <tr><td colSpan={4} className="muted">sin SKUs</td></tr>}
          </tbody>
        </table>

        {!decidible && d.estado !== "apta" && d.estado !== "no_apta" && d.estado !== "parcial" && (
          <p className="muted" style={{ marginTop: 8 }}>
            Los SKUs se pueden marcar apto / no apto cuando la devolución está <b>En oficina</b>
            (después de generar el remito).
          </p>
        )}
      </div>
    </div>
  );
}

function ItemRow({ it, nombre, decidible, saving, genId, flxId, ofiId, onDecidir }: {
  it: DevolucionItem; nombre?: string; decidible: boolean; saving: boolean;
  genId?: string; flxId?: string; ofiId?: string;
  onDecidir: (item_id: string, apta: boolean, opts: { deposito_destino_id?: string; destino_no_apta?: string }) => void;
}) {
  const [modo, setModo] = useState<"" | "apta" | "no">("");
  const [destino, setDestino] = useState(genId ?? ofiId ?? "");
  const [dn, setDn] = useState("tirar");

  const estadoBadge = it.apta === true
    ? <span className="badge ok">apta</span>
    : it.apta === false
      ? <span className="badge sin_stock">baja{it.destino_no_apta ? " · " + it.destino_no_apta : ""}</span>
      : <span className="badge neutral">sin decidir</span>;

  return (
    <tr>
      <td><span className="mono">{it.sku ?? "—"}</span>{nombre && <div className="muted" style={{ fontSize: ".78rem" }}>{nombre}</div>}</td>
      <td>{it.cantidad}</td>
      <td>{estadoBadge}</td>
      <td style={{ textAlign: "right" }}>
        {!decidible || it.apta != null ? <span className="muted">—</span>
          : modo === "" ? (
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button className="btn ok btn-sm" onClick={() => setModo("apta")}>Apta</button>
              <button className="btn bad btn-sm" onClick={() => setModo("no")}>No apta</button>
            </div>
          ) : modo === "apta" ? (
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" }}>
              <select className="select" style={{ width: 96 }} value={destino} onChange={(e) => setDestino(e.target.value)}>
                {ofiId && <option value={ofiId}>Oficina</option>}
                {genId && <option value={genId}>Genpol</option>}
                {flxId && <option value={flxId}>Flexit</option>}
              </select>
              <button className="btn ok btn-sm" disabled={saving} onClick={() => onDecidir(it.id, true, { deposito_destino_id: destino })}>✓</button>
              <button className="btn ghost btn-sm" onClick={() => setModo("")}>✕</button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" }}>
              <select className="select" style={{ width: 100 }} value={dn} onChange={(e) => setDn(e.target.value)}>
                {DEST_NO_APTA.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
              </select>
              <button className="btn bad btn-sm" disabled={saving} onClick={() => onDecidir(it.id, false, { destino_no_apta: dn })}>Baja</button>
              <button className="btn ghost btn-sm" onClick={() => setModo("")}>✕</button>
            </div>
          )}
      </td>
    </tr>
  );
}

// ---- Carga manual (Tienda Nube o cualquier caso sin API) -------------------
function CargaManual({ prods, saving, notify, onDone }: {
  prods: StockConsolidado[]; saving: boolean;
  notify: (m: string) => void; onDone: () => void;
}) {
  const [canal, setCanal] = useState("TN");
  const [depRetiro, setDepRetiro] = useState<"GEN" | "FLX">("FLX");
  const [ventaRef, setVentaRef] = useState("");
  const [motivo, setMotivo] = useState("");
  const [foto, setFoto] = useState<File | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [rows, setRows] = useState<{ producto_id: string; cantidad: number }[]>([]);
  const [pick, setPick] = useState(prods[0]?.producto_id ?? "");
  const [cant, setCant] = useState(1);
  const [busy, setBusy] = useState(false);

  const prodById = useMemo(() => new Map(prods.map((p) => [p.producto_id, p])), [prods]);

  // El canal sugiere el depósito de retiro (ML→Genpol, TN/Flex→Flexit).
  function setCanalAndDep(c: string) { setCanal(c); setDepRetiro(c === "ML" ? "GEN" : "FLX"); }

  function addRow() {
    if (!pick) return;
    setRows((r) => {
      const ex = r.find((x) => x.producto_id === pick);
      if (ex) return r.map((x) => x.producto_id === pick ? { ...x, cantidad: x.cantidad + cant } : x);
      return [...r, { producto_id: pick, cantidad: cant }];
    });
    setCant(1);
  }

  async function guardar() {
    if (!rows.length) return notify("Agregá al menos un SKU");
    setBusy(true);
    try {
      let foto_url: string | undefined;
      if (foto) { setSubiendo(true); foto_url = (await api.subirFoto(foto)) ?? undefined; setSubiendo(false); }
      await api.cargarDevolucion({
        canal, venta_ref: ventaRef || undefined, motivo: motivo || undefined, foto_url,
        deposito_retiro: depRetiro,
        items: rows.map((r) => ({ producto_id: r.producto_id, sku: prodById.get(r.producto_id)?.sku ?? undefined, cantidad: r.cantidad })),
      });
      notify("Devolución cargada · lista para retirar");
      onDone();
    } catch (e) { notify("Error: " + (e as Error).message); }
    finally { setBusy(false); setSubiendo(false); }
  }

  return (
    <div className="card card-pad">
      <h3 style={{ fontSize: "1rem", marginBottom: 12 }}>Cargar devolución manual</h3>
      <div className="row2">
        <div className="field">
          <label>Canal</label>
          <select className="select" value={canal} onChange={(e) => setCanalAndDep(e.target.value)}>
            <option value="TN">Tienda Nube</option>
            <option value="ML">Mercado Libre</option>
            <option value="OTRO">Otro</option>
          </select>
        </div>
        <div className="field">
          <label>Retirar de</label>
          <select className="select" value={depRetiro} onChange={(e) => setDepRetiro(e.target.value as "GEN" | "FLX")}>
            <option value="FLX">Flexit</option>
            <option value="GEN">Genpol</option>
          </select>
        </div>
      </div>
      <div className="row2">
        <div className="field"><label>N° de venta (opcional)</label><input className="input" value={ventaRef} onChange={(e) => setVentaRef(e.target.value)} placeholder="#1234" /></div>
        <div className="field"><label>Motivo (opcional)</label><input className="input" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="No configura wifi…" /></div>
      </div>

      <div className="field">
        <label>SKUs devueltos</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select className="select" style={{ flex: 1, minWidth: 200 }} value={pick} onChange={(e) => setPick(e.target.value)}>
            {prods.map((p) => <option key={p.producto_id} value={p.producto_id}>{p.sku} · {p.nombre}</option>)}
          </select>
          <input className="input" style={{ width: 80 }} type="number" min={1} value={cant} onChange={(e) => setCant(Math.max(1, Number(e.target.value) || 1))} />
          <button className="btn ghost btn-sm" onClick={addRow}>+ Agregar</button>
        </div>
      </div>

      {rows.length > 0 && (
        <ul className="dev-skus" style={{ marginTop: 4 }}>
          {rows.map((r) => (
            <li key={r.producto_id} className="between">
              <span><span className="mono">{prodById.get(r.producto_id)?.sku}</span> <span className="muted">×{r.cantidad}</span></span>
              <button className="btn linky btn-sm" onClick={() => setRows((x) => x.filter((y) => y.producto_id !== r.producto_id))}>quitar</button>
            </li>
          ))}
        </ul>
      )}

      <div className="field" style={{ marginTop: 8 }}>
        <label>Foto (opcional)</label>
        <input type="file" accept="image/*" onChange={(e) => setFoto(e.target.files?.[0] ?? null)} />
        {foto && <span className="muted">{foto.name}</span>}
      </div>
      <button className="btn primary" disabled={busy || saving} onClick={guardar}>
        {subiendo ? "Subiendo foto…" : busy ? "Guardando…" : "Cargar devolución"}
      </button>
    </div>
  );
}
