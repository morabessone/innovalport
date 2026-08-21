import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { Deposito, IngresoItem, StockConsolidado, AltaProducto } from "../lib/types.ts";

type Modo = "existente" | "nuevo" | "variante";
interface Fila extends IngresoItem {
  confirmar: boolean;
  modo: Modo;
  nuevoSku: string;
  nuevoNombre: string;
  baseId: string | null;   // producto padre (variante)
  // Datos para crear el producto COMPLETO en Contabilium (nuevo/variante).
  costo: string;
  precio: string;
  iva: string;             // % (21, 10.5, 27, 0)
  codBarras: string;
  codProv: string;
  stockMin: string;
  // `descripcion` se hereda de IngresoItem (texto detectado por OCR).
}

const IVAS = ["21", "10.5", "27", "0"];

export function Ingreso({ notify }: { notify: (m: string) => void }) {
  const [deps, setDeps] = useState<Deposito[]>([]);
  const [productos, setProductos] = useState<StockConsolidado[]>([]);
  const [destino, setDestino] = useState("");
  const [proveedor, setProveedor] = useState("");
  const [tipo, setTipo] = useState("local");
  const [provsCB, setProvsCB] = useState<{ id: number; nombre: string }[]>([]);
  const [provCBId, setProvCBId] = useState("");   // IDProveedor de Contabilium
  // Términos de compra (para el análisis financiero / ciclo de caja).
  const [condPago, setCondPago] = useState("0");  // días; 0 = contado; "otra" = libre
  const [condOtra, setCondOtra] = useState("");   // días libres si condPago === "otra"
  const [fechaCompra, setFechaCompra] = useState(() => new Date().toISOString().slice(0, 10));
  const [tasaFin, setTasaFin] = useState("");     // % anual si no es contado
  const [ingresoId, setIngresoId] = useState<string | null>(null);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [abierta, setAbierta] = useState<string | null>(null);   // fila con detalle CB desplegado
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      const [d, s] = await Promise.all([api.depositos(), api.stock()]);
      setDeps(d); setProductos(s);
      if (d.find((x) => x.codigo === "GEN")) setDestino(d.find((x) => x.codigo === "GEN")!.id);
      else if (d[0]) setDestino(d[0].id);
      api.proveedoresCB().then(setProvsCB).catch(() => {});
    })();
  }, []);

  const productosP = productos.filter((p) => p.tipo === "P");

  function nuevaFila(base: Partial<Fila>): Fila {
    return {
      id: "man-" + Math.random().toString(36).slice(2, 8),
      descripcion: "", sku_detectado: null, producto_id: null, cantidad: 1,
      costo_unit: null, confianza: 1, confirmado: false,
      confirmar: true, modo: "existente", nuevoSku: "", nuevoNombre: "", baseId: null,
      costo: "", precio: "", iva: "21", codBarras: "", codProv: "", stockMin: "",
      ...base,
    };
  }

  async function onFile(f: File) {
    setReading(true);
    try {
      const b64 = await toBase64(f);
      const res = await api.ocrIngreso(b64, f.type || "image/jpeg", proveedor || undefined, tipo);
      setIngresoId(res.ingreso_id);
      setFilas(res.items.map((i) => nuevaFila({
        ...i, confirmar: i.confianza >= 0.9, modo: "existente",
        nuevoNombre: i.descripcion, nuevoSku: "",
        costo: i.costo_unit != null ? String(i.costo_unit) : "",
      })));
      notify(`Factura leída · ${res.items.length} producto(s)`);
    } catch (e) {
      notify("No se pudo leer la factura: " + (e as Error).message);
    } finally {
      setReading(false);
    }
  }

  function setFila(id: string, patch: Partial<Fila>) {
    setFilas((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }
  function quitar(id: string) { setFilas((fs) => fs.filter((f) => f.id !== id)); }

  function filaLista(f: Fila): boolean {
    if (!f.confirmar || f.cantidad <= 0) return false;
    if (f.modo === "existente") return !!f.producto_id;
    if (f.modo === "nuevo") return !!f.nuevoSku.trim();
    return !!f.nuevoSku.trim() && !!f.baseId; // variante
  }
  const listos = filas.filter(filaLista);

  // Arma el AltaProducto COMPLETO que se creará en Contabilium.
  function altaDe(f: Fila): AltaProducto {
    const numOrUndef = (v: string) => { const n = Number(v); return v.trim() !== "" && Number.isFinite(n) ? n : undefined; };
    return {
      sku: f.nuevoSku.trim(),
      nombre: (f.nuevoNombre || f.descripcion || f.nuevoSku).trim(),
      costo: numOrUndef(f.costo),
      precio: numOrUndef(f.precio),
      iva: numOrUndef(f.iva),
      codigo_barras: f.codBarras.trim() || undefined,
      codigo_proveedor: f.codProv.trim() || undefined,
      id_proveedor_cb: provCBId ? Number(provCBId) : undefined,
      descripcion: f.descripcion.trim() || undefined,
      stock_minimo: numOrUndef(f.stockMin),
    };
  }

  async function confirmar() {
    if (!listos.length) return notify("Marcá al menos un producto completo");
    setSaving(true);
    try {
      const proveedorNombre = provCBId ? (provsCB.find((p) => String(p.id) === provCBId)?.nombre ?? proveedor) : proveedor;
      await api.confirmarIngreso(ingresoId ?? "manual", destino, listos.map((f) => {
        const costoCompra = Number(f.costo || f.costo_unit || 0) || undefined;
        const base = { id: f.id.startsWith("man-") ? undefined : f.id, cantidad: f.cantidad, costo_compra: costoCompra };
        if (f.modo === "existente") return { ...base, producto_id: f.producto_id!, aprender_alias: f.confianza < 0.9 ? f.descripcion : undefined };
        if (f.modo === "nuevo") return { ...base, nuevo: altaDe(f) };
        return { ...base, variante: { ...altaDe(f), base_producto_id: f.baseId! } };
      }), {
        proveedor: proveedorNombre || null,
        fecha_compra: fechaCompra,
        condicion_pago_dias: condPago === "otra" ? (Number(condOtra) || 0) : (Number(condPago) || 0),
        tasa_financiacion: Number(tasaFin) || 0,
      });
      const total = listos.reduce((a, f) => a + f.cantidad, 0);
      const nuevos = listos.filter((f) => f.modo !== "existente").length;
      setFilas([]); setIngresoId(null);
      if (fileRef.current) fileRef.current.value = "";
      const s = await api.stock(); setProductos(s);
      notify(`Ingreso confirmado · ${total} u.${nuevos ? ` · ${nuevos} producto(s) nuevo(s)` : ""}`);
    } catch (e) {
      notify("Error: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <div className="section-head">
        <div><span className="eyebrow">Ingreso</span><h2>Cargar mercadería</h2></div>
        <span className="muted">Foto de factura/remito, o a mano</span>
      </div>

      <div className="card card-pad">
        <div className="row2">
          <div className="field">
            <label>Proveedor (Contabilium)</label>
            <select className="select" value={provCBId} onChange={(e) => setProvCBId(e.target.value)}>
              <option value="">— sin asignar —</option>
              {provsCB.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select>
            {provsCB.length === 0 && (
              <input className="input" style={{ marginTop: 6 }} value={proveedor}
                onChange={(e) => setProveedor(e.target.value)} placeholder="Proveedor (Maty, LBS, Importación…)" />
            )}
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

        {/* Términos de compra → alimentan el ciclo de caja del módulo Finanzas */}
        <div className="row2">
          <div className="field">
            <label>Condición de pago</label>
            <select className="select" value={condPago} onChange={(e) => setCondPago(e.target.value)}>
              <option value="0">Contado</option>
              <option value="30">30 días</option>
              <option value="60">60 días</option>
              <option value="90">90 días</option>
              <option value="otra">Otra (especificar)</option>
            </select>
          </div>
          {condPago === "otra" ? (
            <div className="field">
              <label>Días de pago</label>
              <input className="input" type="number" min={0} value={condOtra} onChange={(e) => setCondOtra(e.target.value)} placeholder="ej: 45" />
            </div>
          ) : (
            <div className="field">
              <label>Fecha de compra</label>
              <input className="input" type="date" value={fechaCompra} onChange={(e) => setFechaCompra(e.target.value)} />
            </div>
          )}
        </div>
        {condPago === "otra" && (
          <div className="field">
            <label>Fecha de compra</label>
            <input className="input" type="date" value={fechaCompra} onChange={(e) => setFechaCompra(e.target.value)} />
          </div>
        )}
        {condPago !== "0" && (
          <div className="field">
            <label>Tasa de financiación anual (%) <span className="muted">— opcional</span></label>
            <input className="input" type="number" step="0.1" value={tasaFin} onChange={(e) => setTasaFin(e.target.value)} placeholder="ej: 40" />
          </div>
        )}

        <input ref={fileRef} type="file" accept="image/*" hidden
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={reading}>
            {reading ? "Leyendo factura…" : "📷 Subir foto de factura / remito"}
          </button>
          <button className="btn" onClick={() => setFilas((fs) => [...fs, nuevaFila({})])}>＋ Agregar producto a mano</button>
        </div>
        {!api.connected && <span className="muted" style={{ marginLeft: 4 }}>(en demo, usa una factura de ejemplo)</span>}
      </div>

      {filas.length > 0 && (
        <div className="card">
          <div className="card-pad" style={{ paddingBottom: 8 }}>
            <h3 style={{ fontSize: "1rem" }}>Productos</h3>
            <p className="muted">Asigná cada producto a uno <b>existente</b>, o marcalo como <b>nuevo</b> o <b>variante</b>. Para los nuevos, completá los datos que hoy lleva un producto en Contabilium; lo que dejes vacío usa el valor por defecto.</p>
          </div>
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th></th><th>Detectado</th><th style={{ minWidth: 340 }}>Producto</th>
                  <th style={{ textAlign: "right" }}>Cant.</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => {
                  const esNuevo = f.modo === "nuevo" || f.modo === "variante";
                  return (
                  <tr key={f.id} style={{ background: f.confianza < 0.6 && f.modo === "existente" && !f.producto_id ? "var(--warn-wash)" : undefined }}>
                    <td style={{ verticalAlign: "top" }}><input type="checkbox" checked={f.confirmar} onChange={(e) => setFila(f.id, { confirmar: e.target.checked })} /></td>
                    <td style={{ fontSize: ".84rem", maxWidth: 200, verticalAlign: "top" }}>{f.descripcion || <span className="muted">(a mano)</span>}</td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ display: "flex", gap: 6 }}>
                          <select className="select" style={{ width: 118, flex: "0 0 auto" }} value={f.modo}
                            onChange={(e) => setFila(f.id, { modo: e.target.value as Modo })}>
                            <option value="existente">Existente</option>
                            <option value="nuevo">Nuevo</option>
                            <option value="variante">Variante</option>
                          </select>
                          {f.modo === "existente" && (
                            <select className="select grow" value={f.producto_id ?? ""}
                              onChange={(e) => setFila(f.id, { producto_id: e.target.value || null })}>
                              <option value="">— asignar SKU —</option>
                              {productos.map((p) => <option key={p.producto_id} value={p.producto_id}>{p.sku}{p.tipo !== "P" ? ` (${p.tipo})` : ""}</option>)}
                            </select>
                          )}
                          {f.modo === "variante" && (
                            <select className="select grow" value={f.baseId ?? ""}
                              onChange={(e) => setFila(f.id, { baseId: e.target.value || null })}>
                              <option value="">— producto base —</option>
                              {productosP.map((p) => <option key={p.producto_id} value={p.producto_id}>{p.sku}</option>)}
                            </select>
                          )}
                        </div>
                        {esNuevo && (
                          <>
                            <div style={{ display: "flex", gap: 6 }}>
                              <input className="input" style={{ width: 150 }} placeholder="SKU nuevo" value={f.nuevoSku}
                                onChange={(e) => setFila(f.id, { nuevoSku: e.target.value })} />
                              <input className="input grow" placeholder="Nombre" value={f.nuevoNombre}
                                onChange={(e) => setFila(f.id, { nuevoNombre: e.target.value })} />
                              <button type="button" className="btn ghost btn-sm" style={{ flex: "0 0 auto" }}
                                onClick={() => setAbierta(abierta === f.id ? null : f.id)}>
                                {abierta === f.id ? "▲ datos" : "▼ datos Contabilium"}
                              </button>
                            </div>
                            {abierta === f.id && (
                              <div className="cb-fields" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: "8px", background: "var(--surface-2, rgba(0,0,0,.03))", borderRadius: 8 }}>
                                <label className="mini">Costo
                                  <input className="input" type="number" step="0.01" min={0} value={f.costo}
                                    onChange={(e) => setFila(f.id, { costo: e.target.value })} placeholder="0.00" /></label>
                                <label className="mini">Precio venta (neto)
                                  <input className="input" type="number" step="0.01" min={0} value={f.precio}
                                    onChange={(e) => setFila(f.id, { precio: e.target.value })} placeholder="0.00" /></label>
                                <label className="mini">IVA %
                                  <select className="select" value={f.iva} onChange={(e) => setFila(f.id, { iva: e.target.value })}>
                                    {IVAS.map((v) => <option key={v} value={v}>{v}%</option>)}
                                  </select></label>
                                <label className="mini">Stock mínimo
                                  <input className="input" type="number" min={0} value={f.stockMin}
                                    onChange={(e) => setFila(f.id, { stockMin: e.target.value })} placeholder="0" /></label>
                                <label className="mini">Código de barras
                                  <input className="input" value={f.codBarras}
                                    onChange={(e) => setFila(f.id, { codBarras: e.target.value })} placeholder="EAN / UPC" /></label>
                                <label className="mini">Código proveedor
                                  <input className="input" value={f.codProv}
                                    onChange={(e) => setFila(f.id, { codProv: e.target.value })} placeholder="ref. del proveedor" /></label>
                                <label className="mini" style={{ gridColumn: "1 / -1" }}>Descripción
                                  <input className="input" value={f.descripcion}
                                    onChange={(e) => setFila(f.id, { descripcion: e.target.value })} placeholder="detalle opcional" /></label>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                    <td style={{ textAlign: "right", verticalAlign: "top" }}>
                      <input className="input qtybox" type="number" min={1} value={f.cantidad}
                        onChange={(e) => setFila(f.id, { cantidad: Math.max(1, Number(e.target.value) || 1) })} />
                    </td>
                    <td style={{ verticalAlign: "top" }}>
                      <button className="btn ghost btn-sm" onClick={() => quitar(f.id)} title="Quitar producto">✕</button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="card-pad between">
            <span className="muted">{listos.length} producto(s) listos {listos.some((f) => f.modo !== "existente") && "· incluye altas nuevas"}</span>
            <button className="btn primary" onClick={confirmar} disabled={saving || !listos.length}>
              {saving ? "Confirmando…" : "Confirmar ingreso"}
            </button>
          </div>
        </div>
      )}

      <p className="muted" style={{ fontSize: ".8rem" }}>
        Los <b>productos nuevos</b> y <b>variantes</b> se crean en la app con todos sus datos y quedan marcados como
        pendientes de alta en Contabilium (se crean allá con la info completa cuando activemos la escritura). El stock
        del depósito queda cargado igual.
      </p>
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
