import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { Deposito, Devolucion, StockConsolidado } from "../lib/types.ts";

const DEST_NO_APTA = [
  { v: "tirar", l: "Tirar" },
  { v: "outlet", l: "Outlet" },
  { v: "repuesto", l: "Repuesto" },
];

export function Devoluciones({ notify }: { notify: (m: string) => void }) {
  const [deps, setDeps] = useState<Deposito[]>([]);
  const [prods, setProds] = useState<StockConsolidado[]>([]);
  const [lista, setLista] = useState<Devolucion[]>([]);
  const [saving, setSaving] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);

  // form
  const [producto, setProducto] = useState("");
  const [cantidad, setCantidad] = useState(1);
  const [canal, setCanal] = useState("ML");
  const [ventaRef, setVentaRef] = useState("");
  const [motivo, setMotivo] = useState("");
  const [foto, setFoto] = useState<File | null>(null);
  const [subiendo, setSubiendo] = useState(false);

  async function load() {
    const [d, p, l] = await Promise.all([api.depositos(), api.stock(), api.devoluciones()]);
    setDeps(d); setProds(p); setLista(l);
    if (!producto && p[0]) setProducto(p[0].producto_id);
  }
  useEffect(() => { load(); }, []);

  const depByCode = (c: string) => deps.find((d) => d.codigo === c);
  const nombreProd = (dv: Devolucion) => dv.sku ?? prods.find((p) => p.producto_id === dv.producto_id)?.sku ?? "—";

  async function cargar() {
    if (!producto) return notify("Elegí un producto");
    if (!motivo.trim()) return notify("El motivo es obligatorio");
    setSaving(true);
    try {
      let foto_url: string | undefined;
      if (foto) { setSubiendo(true); foto_url = (await api.subirFoto(foto)) ?? undefined; setSubiendo(false); }
      const origen = canal === "ML" ? depByCode("GEN") : depByCode("FLX");
      await api.cargarDevolucion({
        producto_id: producto, sku: prods.find((p) => p.producto_id === producto)?.sku,
        cantidad, canal, venta_ref: ventaRef || undefined, motivo, foto_url,
        deposito_origen_id: origen?.id ?? deps[0].id,
      });
      setVentaRef(""); setMotivo(""); setCantidad(1); setFoto(null);
      await load();
      notify("Devolución cargada · remito de retiro generado");
    } catch (e) {
      notify("Error: " + (e as Error).message);
    } finally {
      setSaving(false); setSubiendo(false);
    }
  }

  async function recibir(id: string) {
    setSaving(true);
    try { await api.recibirDevolucion(id); await load(); notify("Marcada como recibida en oficina"); }
    catch (e) { notify("Error: " + (e as Error).message); } finally { setSaving(false); }
  }

  async function decidir(id: string, apta: boolean, opts: { destino?: string; destino_no_apta?: string }) {
    setSaving(true);
    try {
      await api.decidirDevolucion({ devolucion_id: id, apta, deposito_destino_id: opts.destino, destino_no_apta: opts.destino_no_apta });
      setDeciding(null); await load();
      notify(apta ? "Apta · reingresada al stock (+ nota de crédito)" : "No apta · dada de baja");
    } catch (e) { notify("Error: " + (e as Error).message); } finally { setSaving(false); }
  }

  const porRetirar = lista.filter((d) => ["cargada", "retiro_generado"].includes(d.estado));
  const enOficina = lista.filter((d) => d.estado === "en_oficina");
  const resueltas = lista.filter((d) => ["apta", "no_apta"].includes(d.estado));

  function Card({ d, children }: { d: Devolucion; children?: React.ReactNode }) {
    return (
      <div className="kb-card">
        <div className="between">
          <span className="sku mono">{nombreProd(d)}</span>
          <span className="badge neutral">{d.canal ?? "—"} · {d.cantidad}u</span>
        </div>
        {d.motivo && <p className="kb-motivo">{d.motivo}</p>}
        {d.foto_url && <a href={d.foto_url} target="_blank" rel="noreferrer"><img className="kb-foto" src={d.foto_url} alt="foto devolución" /></a>}
        {children}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="section-head">
        <div><span className="eyebrow">Devoluciones</span><h2>Circuito de devoluciones</h2></div>
        <span className="muted">{porRetirar.length + enOficina.length} pendiente(s)</span>
      </div>

      {/* Cargar */}
      <div className="card card-pad">
        <h3 style={{ fontSize: "1rem", marginBottom: 12 }}>Cargar una devolución</h3>
        <div className="row2">
          <div className="field">
            <label>Producto</label>
            <select className="select" value={producto} onChange={(e) => setProducto(e.target.value)}>
              {prods.map((p) => <option key={p.producto_id} value={p.producto_id}>{p.sku} · {p.nombre}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Canal</label>
            <select className="select" value={canal} onChange={(e) => setCanal(e.target.value)}>
              <option value="ML">Mercado Libre (Full → Genpol)</option>
              <option value="TN">Tienda Nube / Flex → Flexit</option>
            </select>
          </div>
        </div>
        <div className="row2">
          <div className="field"><label>Cantidad</label><input className="input" type="number" min={1} value={cantidad} onChange={(e) => setCantidad(Math.max(1, Number(e.target.value) || 1))} /></div>
          <div className="field"><label>N° de venta (opcional)</label><input className="input" value={ventaRef} onChange={(e) => setVentaRef(e.target.value)} placeholder="2000004512345" /></div>
        </div>
        <div className="field">
          <label>Motivo <span style={{ color: "var(--bad)" }}>*</span></label>
          <input className="input" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="No configura wifi, llegó dañado…" />
        </div>
        <div className="field">
          <label>Foto (opcional — sirve para reclamar al proveedor)</label>
          <input type="file" accept="image/*" onChange={(e) => setFoto(e.target.files?.[0] ?? null)} />
          {foto && <span className="muted">{foto.name}</span>}
        </div>
        <button className="btn primary" onClick={cargar} disabled={saving}>{subiendo ? "Subiendo foto…" : saving ? "Cargando…" : "Cargar y generar retiro"}</button>
      </div>

      {/* Kanban */}
      <div className="kanban">
        <div className="kb-col">
          <div className="kb-head"><span>Por retirar</span><span className="kb-count">{porRetirar.length}</span></div>
          {porRetirar.length === 0 && <p className="kb-empty">—</p>}
          {porRetirar.map((d) => (
            <Card d={d} key={d.id}>
              <button className="btn ghost btn-sm" disabled={saving} onClick={() => recibir(d.id)}>Recibí en oficina →</button>
            </Card>
          ))}
        </div>

        <div className="kb-col">
          <div className="kb-head"><span>En oficina · revisar</span><span className="kb-count">{enOficina.length}</span></div>
          {enOficina.length === 0 && <p className="kb-empty">—</p>}
          {enOficina.map((d) => (
            <Card d={d} key={d.id}>
              {deciding === d.id
                ? <Decision deps={deps} saving={saving}
                    onApta={(destino) => decidir(d.id, true, { destino })}
                    onNoApta={(dn) => decidir(d.id, false, { destino_no_apta: dn })}
                    onCancel={() => setDeciding(null)} />
                : <button className="btn primary btn-sm" onClick={() => setDeciding(d.id)}>Decidir</button>}
            </Card>
          ))}
        </div>

        <div className="kb-col">
          <div className="kb-head"><span>Resueltas</span><span className="kb-count">{resueltas.length}</span></div>
          {resueltas.length === 0 && <p className="kb-empty">—</p>}
          {resueltas.map((d) => (
            <Card d={d} key={d.id}>
              {d.estado === "apta"
                ? <span className="badge ok">Apta · reingresada</span>
                : <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <span className="badge sin_stock">No apta{d.destino_no_apta ? " · " + d.destino_no_apta : ""}</span>
                    {d.valor_perdida != null && <span className="muted mono">−${Number(d.valor_perdida).toLocaleString("es-AR")}</span>}
                  </div>}
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

function Decision({ deps, saving, onApta, onNoApta, onCancel }: {
  deps: Deposito[]; saving: boolean;
  onApta: (destino: string) => void; onNoApta: (dn: string) => void; onCancel: () => void;
}) {
  const [modo, setModo] = useState<"" | "apta" | "no">("");
  const [destino, setDestino] = useState(deps.find((d) => d.codigo === "GEN")?.id ?? deps[0]?.id ?? "");
  const [dn, setDn] = useState("tirar");
  if (modo === "") return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <button className="btn ok btn-sm" onClick={() => setModo("apta")}>Apta</button>
      <button className="btn bad btn-sm" onClick={() => setModo("no")}>No apta</button>
      <button className="btn ghost btn-sm" onClick={onCancel}>✕</button>
    </div>
  );
  if (modo === "apta") return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <select className="select" style={{ width: 92 }} value={destino} onChange={(e) => setDestino(e.target.value)}>
        {deps.map((d) => <option key={d.id} value={d.id}>{d.codigo}</option>)}
      </select>
      <button className="btn ok btn-sm" disabled={saving} onClick={() => onApta(destino)}>Reingresar</button>
      <button className="btn ghost btn-sm" onClick={onCancel}>✕</button>
    </div>
  );
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <select className="select" style={{ width: 110 }} value={dn} onChange={(e) => setDn(e.target.value)}>
        {DEST_NO_APTA.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
      <button className="btn bad btn-sm" disabled={saving} onClick={() => onNoApta(dn)}>Dar de baja</button>
      <button className="btn ghost btn-sm" onClick={onCancel}>✕</button>
    </div>
  );
}
