import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { Scanner } from "./Scanner.tsx";
import type { Deposito, StockConsolidado, Remito } from "../lib/types.ts";

export function Movimiento({ notify }: { notify: (m: string) => void }) {
  const [deps, setDeps] = useState<Deposito[]>([]);
  const [stock, setStock] = useState<StockConsolidado[]>([]);
  const [remitos, setRemitos] = useState<Remito[]>([]);
  const [origen, setOrigen] = useState("");
  const [destino, setDestino] = useState("");
  const [cant, setCant] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [scan, setScan] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);

  async function load() {
    const [d, s, r] = await Promise.all([api.depositos(), api.stock(), api.remitos(10)]);
    setDeps(d); setStock(s); setRemitos(r);
    if (!origen && d[0]) setOrigen(d[0].id);
    if (!destino && d[2]) setDestino(d[2].id);
  }
  useEffect(() => { load(); }, []);

  const codigoOrigen = deps.find((d) => d.id === origen)?.codigo ?? "";
  const disponibles = useMemo(() => {
    const t = q.trim().toLowerCase();
    return stock.filter((s) => (s.por_deposito[codigoOrigen] ?? 0) > 0 && (!t || `${s.sku} ${s.nombre}`.toLowerCase().includes(t)));
  }, [stock, codigoOrigen, q]);

  const items = Object.entries(cant).filter(([, q]) => q > 0).map(([producto_id, cantidad]) => ({ producto_id, cantidad }));
  const totalUnidades = items.reduce((a, i) => a + i.cantidad, 0);
  const mismoDeposito = origen === destino;

  function onScan(code: string) {
    setScan(false);
    const s = stock.find((x) => x.sku.toLowerCase() === code.toLowerCase());
    if (!s) return notify(`No encontré "${code}" (¿SKU correcto?)`);
    const disp = s.por_deposito[codigoOrigen] ?? 0;
    if (disp <= 0) return notify(`${s.sku} no tiene stock en ${codigoOrigen}`);
    setCant((c) => ({ ...c, [s.producto_id]: Math.min(disp, (c[s.producto_id] ?? 0) + 1) }));
    notify(`+1 ${s.sku}`);
  }

  async function submit() {
    if (mismoDeposito) return notify("Elegí depósitos distintos");
    if (!items.length) return notify("Cargá al menos un producto");
    setSaving(true);
    try {
      await api.moverStock(origen, destino, items);
      setCant({}); await load();
      notify(`Remito generado · ${totalUnidades} u.`);
    } catch (e) { notify("Error: " + (e as Error).message); } finally { setSaving(false); }
  }

  async function deshacer(r: Remito) {
    if (!confirm(`¿Deshacer el remito R-${String(r.numero_int).padStart(6, "0")}? Revierte el movimiento.`)) return;
    setUndoing(r.id);
    try { await api.deshacerRemito(r.id); await load(); notify("Remito deshecho"); }
    catch (e) { notify("Error: " + (e as Error).message); } finally { setUndoing(null); }
  }

  const depName = (id: string | null) => deps.find((d) => d.id === id)?.codigo ?? "—";

  return (
    <div className="stack">
      <div className="section-head">
        <div><span className="eyebrow">Movimiento</span><h2>Mover stock entre depósitos</h2></div>
        <span className="muted">El remito se genera solo</span>
      </div>

      <div className="card card-pad">
        <div className="row2">
          <div className="field"><label>Desde</label>
            <select className="select" value={origen} onChange={(e) => { setOrigen(e.target.value); setCant({}); }}>
              {deps.map((d) => <option key={d.id} value={d.id}>{d.codigo} · {d.nombre}</option>)}
            </select>
          </div>
          <div className="field"><label>Hacia</label>
            <select className="select" value={destino} onChange={(e) => setDestino(e.target.value)}>
              {deps.map((d) => <option key={d.id} value={d.id}>{d.codigo} · {d.nombre}</option>)}
            </select>
          </div>
        </div>
        {mismoDeposito && <div className="pill-note">Elegí un depósito de origen distinto al de destino.</div>}

        <div style={{ display: "flex", gap: 8, margin: "6px 0 2px" }}>
          <input className="input grow" placeholder={`Buscar en ${codigoOrigen}…`} value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={() => setScan(true)}>📷 Escanear</button>
        </div>

        <div className="scroll-x">
          <table className="tbl">
            <thead><tr><th>Producto</th><th style={{ textAlign: "right" }}>Disp. {codigoOrigen}</th><th style={{ textAlign: "right" }}>Mover</th></tr></thead>
            <tbody>
              {disponibles.length === 0 && <tr><td colSpan={3} className="empty">Sin stock en este depósito.</td></tr>}
              {disponibles.slice(0, 60).map((s) => {
                const disp = s.por_deposito[codigoOrigen] ?? 0;
                return (
                  <tr key={s.producto_id} style={{ background: (cant[s.producto_id] ?? 0) > 0 ? "var(--accent-wash)" : undefined }}>
                    <td className="sku">{s.sku}<small>{s.nombre}</small></td>
                    <td className="tnum" style={{ textAlign: "right" }}>{disp}</td>
                    <td style={{ textAlign: "right" }}>
                      <input className="input qtybox" type="number" min={0} max={disp} value={cant[s.producto_id] ?? ""} placeholder="0"
                        onChange={(e) => setCant((c) => ({ ...c, [s.producto_id]: Math.max(0, Math.min(disp, Number(e.target.value) || 0)) }))} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="between" style={{ marginTop: 16 }}>
          <span className="muted">{items.length} producto(s) · {totalUnidades} u.</span>
          <button className="btn primary" onClick={submit} disabled={saving || mismoDeposito || !items.length}>{saving ? "Generando…" : "Generar remito"}</button>
        </div>
      </div>

      <div className="card">
        <div className="card-pad" style={{ paddingBottom: 0 }}><h3 style={{ fontSize: "1rem" }}>Últimos remitos</h3></div>
        <div className="scroll-x">
          <table className="tbl">
            <thead><tr><th>Remito</th><th>Tipo</th><th>Origen → Destino</th><th>Fecha</th><th></th></tr></thead>
            <tbody>
              {remitos.length === 0 && <tr><td colSpan={5} className="empty">Sin remitos.</td></tr>}
              {remitos.map((r) => (
                <tr key={r.id} style={{ opacity: r.estado === "anulado" ? 0.5 : 1 }}>
                  <td className="mono">R-{String(r.numero_int).padStart(6, "0")}</td>
                  <td><span className="badge neutral">{r.tipo}</span></td>
                  <td className="mono" style={{ fontSize: ".82rem" }}>{depName(r.origen_deposito_id)} → {depName(r.destino_deposito_id)}</td>
                  <td className="muted">{new Date(r.created_at).toLocaleDateString("es-AR")}</td>
                  <td style={{ textAlign: "right" }}>
                    {r.tipo === "movimiento" && r.estado !== "anulado"
                      ? <button className="btn ghost btn-sm" disabled={undoing === r.id} onClick={() => deshacer(r)}>Deshacer</button>
                      : r.estado === "anulado" ? <span className="muted">anulado</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {scan && <Scanner onDetect={onScan} onClose={() => setScan(false)} />}
    </div>
  );
}
