import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { Deposito, IngresoItem, StockConsolidado } from "../lib/types.ts";

interface Fila extends IngresoItem { confirmar: boolean; }

export function Ingreso({ notify }: { notify: (m: string) => void }) {
  const [deps, setDeps] = useState<Deposito[]>([]);
  const [productos, setProductos] = useState<StockConsolidado[]>([]);
  const [destino, setDestino] = useState("");
  const [proveedor, setProveedor] = useState("");
  const [tipo, setTipo] = useState("local");
  const [ingresoId, setIngresoId] = useState<string | null>(null);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mprod, setMprod] = useState("");
  const [mqty, setMqty] = useState(1);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      const [d, s] = await Promise.all([api.depositos(), api.stock()]);
      setDeps(d); setProductos(s);
      if (d.find((x) => x.codigo === "GEN")) setDestino(d.find((x) => x.codigo === "GEN")!.id);
      else if (d[0]) setDestino(d[0].id);
    })();
  }, []);

  async function onFile(f: File) {
    setReading(true);
    try {
      const b64 = await toBase64(f);
      const res = await api.ocrIngreso(b64, f.type || "image/jpeg", proveedor || undefined, tipo);
      setIngresoId(res.ingreso_id);
      setFilas(res.items.map((i) => ({ ...i, confirmar: i.confianza >= 0.9 })));
      notify(`Factura leída · ${res.items.length} renglón(es)`);
    } catch (e) {
      notify("No se pudo leer la factura: " + (e as Error).message);
    } finally {
      setReading(false);
    }
  }

  function setFila(id: string, patch: Partial<Fila>) {
    setFilas((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  function agregarManual() {
    if (!mprod) return notify("Elegí un producto");
    const p = productos.find((x) => x.producto_id === mprod);
    setFilas((fs) => [...fs, {
      id: "man-" + Math.random().toString(36).slice(2, 8),
      descripcion: p?.sku ?? "manual", sku_detectado: p?.sku ?? null,
      producto_id: mprod, cantidad: Math.max(1, mqty), costo_unit: null,
      confianza: 1, confirmado: true, confirmar: true,
    }]);
    setMqty(1);
    notify(`${p?.sku} agregado`);
  }

  const listos = filas.filter((f) => f.confirmar && f.producto_id && f.cantidad > 0);

  async function confirmar() {
    if (!listos.length) return notify("Marcá al menos un renglón con producto asignado");
    setSaving(true);
    try {
      await api.confirmarIngreso(
        ingresoId ?? "manual", destino,
        listos.map((f) => ({
          id: f.id.startsWith("man-") ? undefined : f.id,
          producto_id: f.producto_id!, cantidad: f.cantidad,
          aprender_alias: f.confianza < 0.9 ? f.descripcion : undefined,
        })),
      );
      const total = listos.reduce((a, f) => a + f.cantidad, 0);
      setFilas([]); setIngresoId(null);
      if (fileRef.current) fileRef.current.value = "";
      const s = await api.stock(); setProductos(s);
      notify(`Ingreso confirmado · ${total} u. dadas de alta`);
    } catch (e) {
      notify("Error: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <div className="section-head">
        <div><span className="eyebrow">Ingreso</span><h2>Cargar mercadería por foto</h2></div>
        <span className="muted">Sacás una foto, el sistema la lee</span>
      </div>

      <div className="card card-pad">
        <div className="row2">
          <div className="field">
            <label>Proveedor</label>
            <input className="input" value={proveedor} onChange={(e) => setProveedor(e.target.value)} placeholder="Maty, LBS, Importación…" />
          </div>
          <div className="field">
            <label>Tipo</label>
            <select className="select" value={tipo} onChange={(e) => setTipo(e.target.value)}>
              <option value="local">Proveedor local</option>
              <option value="impo">Importación</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label>Depósito destino</label>
          <select className="select" value={destino} onChange={(e) => setDestino(e.target.value)}>
            {deps.map((d) => <option key={d.id} value={d.id}>{d.codigo} · {d.nombre}</option>)}
          </select>
        </div>

        <input ref={fileRef} type="file" accept="image/*" hidden
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={reading}>
          {reading ? "Leyendo factura…" : "📷 Subir foto de factura / remito"}
        </button>
        {!api.connected && <span className="muted" style={{ marginLeft: 12 }}>(en demo, usa una factura de ejemplo)</span>}
      </div>

      <div className="card card-pad">
        <h3 style={{ fontSize: "1rem", marginBottom: 10 }}>…o cargá a mano</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field grow" style={{ marginBottom: 0, minWidth: 180 }}>
            <label>Producto</label>
            <select className="select" value={mprod} onChange={(e) => setMprod(e.target.value)}>
              <option value="">— elegí —</option>
              {productos.map((p) => <option key={p.producto_id} value={p.producto_id}>{p.sku} · {p.nombre}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Cantidad</label>
            <input className="input qtybox" type="number" min={1} value={mqty} onChange={(e) => setMqty(Math.max(1, Number(e.target.value) || 1))} />
          </div>
          <button className="btn" onClick={agregarManual}>＋ Agregar</button>
        </div>
      </div>

      {filas.length > 0 && (
        <div className="card">
          <div className="card-pad" style={{ paddingBottom: 8 }}>
            <h3 style={{ fontSize: "1rem" }}>Renglones detectados</h3>
            <p className="muted">Revisá los que están en amarillo (baja confianza) y asigná el producto correcto.</p>
          </div>
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr><th></th><th>Detectado</th><th>Producto</th><th style={{ textAlign: "right" }}>Cant.</th><th>Confianza</th></tr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <tr key={f.id} style={{ background: f.confianza < 0.6 ? "var(--warn-wash)" : undefined }}>
                    <td>
                      <input type="checkbox" checked={f.confirmar}
                        onChange={(e) => setFila(f.id, { confirmar: e.target.checked })} />
                    </td>
                    <td style={{ fontSize: ".86rem" }}>{f.descripcion}</td>
                    <td>
                      <select className="select" value={f.producto_id ?? ""}
                        onChange={(e) => setFila(f.id, { producto_id: e.target.value || null })}>
                        <option value="">— sin asignar —</option>
                        {productos.map((p) => <option key={p.producto_id} value={p.producto_id}>{p.sku}</option>)}
                      </select>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <input className="input qtybox" type="number" min={1} value={f.cantidad}
                        onChange={(e) => setFila(f.id, { cantidad: Math.max(1, Number(e.target.value) || 1) })} />
                    </td>
                    <td>
                      <div className="confbar"><i style={{ width: `${Math.round(f.confianza * 100)}%` }} /></div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-pad between">
            <span className="muted">{listos.length} renglón(es) listos para dar de alta</span>
            <button className="btn primary" onClick={confirmar} disabled={saving || !listos.length}>
              {saving ? "Confirmando…" : "Confirmar ingreso"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
