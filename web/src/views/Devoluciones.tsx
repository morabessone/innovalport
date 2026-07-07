import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { Deposito, Devolucion, StockConsolidado } from "../lib/types.ts";

const PENDIENTES = ["cargada", "retiro_generado", "en_oficina"];
const ESTADO: Record<string, { label: string; cls: string }> = {
  cargada: { label: "cargada", cls: "neutral" },
  retiro_generado: { label: "retiro generado", cls: "reponer" },
  en_oficina: { label: "en oficina", cls: "reponer" },
  apta: { label: "apta · repuesta", cls: "ok" },
  no_apta: { label: "no apta · baja", cls: "sin_stock" },
};

export function Devoluciones({ notify }: { notify: (m: string) => void }) {
  const [deps, setDeps] = useState<Deposito[]>([]);
  const [prods, setProds] = useState<StockConsolidado[]>([]);
  const [lista, setLista] = useState<Devolucion[]>([]);
  const [saving, setSaving] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);

  // form nueva devolución
  const [producto, setProducto] = useState("");
  const [cantidad, setCantidad] = useState(1);
  const [canal, setCanal] = useState("ML");
  const [ventaRef, setVentaRef] = useState("");
  const [motivo, setMotivo] = useState("");

  async function load() {
    const [d, p, l] = await Promise.all([api.depositos(), api.stock(), api.devoluciones()]);
    setDeps(d); setProds(p); setLista(l);
    if (!producto && p[0]) setProducto(p[0].producto_id);
  }
  useEffect(() => { load(); }, []);

  const depByCode = (code: string) => deps.find((d) => d.codigo === code);

  async function cargar() {
    if (!producto) return notify("Elegí un producto");
    setSaving(true);
    try {
      // Full → devolución llega a Genpol; Flex → llega a Flexit.
      const origen = canal === "ML" ? depByCode("GEN") : depByCode("FLX");
      await api.cargarDevolucion({
        producto_id: producto,
        sku: prods.find((p) => p.producto_id === producto)?.sku,
        cantidad, canal, venta_ref: ventaRef || undefined, motivo: motivo || undefined,
        deposito_origen_id: origen?.id ?? deps[0].id,
      });
      setVentaRef(""); setMotivo(""); setCantidad(1);
      await load();
      notify("Devolución cargada · remito de retiro generado");
    } catch (e) {
      notify("Error: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function decidir(id: string, apta: boolean, destino?: string, valor?: number) {
    setSaving(true);
    try {
      await api.decidirDevolucion({ devolucion_id: id, apta, deposito_destino_id: destino, valor_perdida: valor });
      setDeciding(null);
      await load();
      notify(apta ? "Devolución apta · alta sin compra + nota de crédito" : "Devolución no apta · dada de baja");
    } catch (e) {
      notify("Error: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const pendientes = lista.filter((d) => PENDIENTES.includes(d.estado));
  const nombreProd = (d: Devolucion) => d.sku ?? prods.find((p) => p.producto_id === d.producto_id)?.sku ?? "—";

  return (
    <div className="stack">
      <div className="section-head">
        <div><span className="eyebrow">Devoluciones</span><h2>Circuito de devoluciones</h2></div>
        <span className="muted">{pendientes.length} pendiente(s) de decidir</span>
      </div>

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
          <div className="field">
            <label>Cantidad</label>
            <input className="input" type="number" min={1} value={cantidad} onChange={(e) => setCantidad(Math.max(1, Number(e.target.value) || 1))} />
          </div>
          <div className="field">
            <label>N° de venta (opcional)</label>
            <input className="input" value={ventaRef} onChange={(e) => setVentaRef(e.target.value)} placeholder="2000004512345" />
          </div>
        </div>
        <div className="field">
          <label>Motivo (opcional)</label>
          <input className="input" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="No configura wifi, llegó dañado…" />
        </div>
        <button className="btn primary" onClick={cargar} disabled={saving}>Cargar y generar retiro</button>
      </div>

      <div className="card">
        <div className="card-pad" style={{ paddingBottom: 8 }}>
          <h3 style={{ fontSize: "1rem" }}>Todas vuelven a la Oficina para revisión</h3>
          <p className="muted">Apta → reingresa al stock (alta sin compra) + nota de crédito. No apta → baja con la pérdida registrada.</p>
        </div>
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr><th>Producto</th><th>Canal</th><th style={{ textAlign: "right" }}>Cant.</th><th>Motivo</th><th>Estado</th><th></th></tr>
            </thead>
            <tbody>
              {lista.length === 0 && <tr><td colSpan={6} className="empty">Sin devoluciones.</td></tr>}
              {lista.map((d) => (
                <tr key={d.id}>
                  <td className="sku">{nombreProd(d)}</td>
                  <td><span className="badge neutral">{d.canal ?? "—"}</span></td>
                  <td className="tnum" style={{ textAlign: "right" }}>{d.cantidad}</td>
                  <td style={{ fontSize: ".84rem", maxWidth: 200 }}>{d.motivo ?? "—"}</td>
                  <td><span className={"badge " + ESTADO[d.estado].cls}>{ESTADO[d.estado].label}</span></td>
                  <td style={{ textAlign: "right" }}>
                    {PENDIENTES.includes(d.estado) && deciding !== d.id && (
                      <button className="btn ghost" onClick={() => setDeciding(d.id)}>Decidir</button>
                    )}
                    {deciding === d.id && (
                      <DecisionForm
                        deps={deps} saving={saving}
                        onApta={(destino) => decidir(d.id, true, destino)}
                        onNoApta={(valor) => decidir(d.id, false, undefined, valor)}
                        onCancel={() => setDeciding(null)}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function DecisionForm({ deps, saving, onApta, onNoApta, onCancel }: {
  deps: Deposito[]; saving: boolean;
  onApta: (destino: string) => void; onNoApta: (valor: number) => void; onCancel: () => void;
}) {
  const [modo, setModo] = useState<"" | "apta" | "no">("");
  const [destino, setDestino] = useState(deps.find((d) => d.codigo === "GEN")?.id ?? deps[0]?.id ?? "");
  const [valor, setValor] = useState<number>(0);

  if (modo === "") {
    return (
      <div style={{ display: "inline-flex", gap: 6 }}>
        <button className="btn ok" onClick={() => setModo("apta")}>Apta</button>
        <button className="btn bad" onClick={() => setModo("no")}>No apta</button>
        <button className="btn ghost" onClick={onCancel}>✕</button>
      </div>
    );
  }
  if (modo === "apta") {
    return (
      <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        <select className="select" style={{ width: 120 }} value={destino} onChange={(e) => setDestino(e.target.value)}>
          {deps.map((d) => <option key={d.id} value={d.id}>{d.codigo}</option>)}
        </select>
        <button className="btn ok" disabled={saving} onClick={() => onApta(destino)}>Confirmar alta</button>
        <button className="btn ghost" onClick={onCancel}>✕</button>
      </div>
    );
  }
  return (
    <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <input className="input" style={{ width: 110 }} type="number" min={0} placeholder="Pérdida $" value={valor || ""} onChange={(e) => setValor(Number(e.target.value) || 0)} />
      <button className="btn bad" disabled={saving} onClick={() => onNoApta(valor)}>Dar de baja</button>
      <button className="btn ghost" onClick={onCancel}>✕</button>
    </div>
  );
}
