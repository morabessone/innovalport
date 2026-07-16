import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { Deposito, IngresoItem, StockConsolidado } from "../lib/types.ts";

type Modo = "existente" | "nuevo" | "variante";
interface Fila extends IngresoItem {
  confirmar: boolean;
  modo: Modo;
  nuevoSku: string;
  nuevoNombre: string;
  baseId: string | null;   // producto padre (variante)
}

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
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      const [d, s] = await Promise.all([api.depositos(), api.stock()]);
      setDeps(d); setProductos(s);
      if (d.find((x) => x.codigo === "GEN")) setDestino(d.find((x) => x.codigo === "GEN")!.id);
      else if (d[0]) setDestino(d[0].id);
    })();
  }, []);

  const productosP = productos.filter((p) => p.tipo === "P");

  function nuevaFila(base: Partial<Fila>): Fila {
    return {
      id: "man-" + Math.random().toString(36).slice(2, 8),
      descripcion: "", sku_detectado: null, producto_id: null, cantidad: 1,
      costo_unit: null, confianza: 1, confirmado: false,
      confirmar: true, modo: "existente", nuevoSku: "", nuevoNombre: "", baseId: null,
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
      })));
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
  function quitar(id: string) { setFilas((fs) => fs.filter((f) => f.id !== id)); }

  function filaLista(f: Fila): boolean {
    if (!f.confirmar || f.cantidad <= 0) return false;
    if (f.modo === "existente") return !!f.producto_id;
    if (f.modo === "nuevo") return !!f.nuevoSku.trim();
    return !!f.nuevoSku.trim() && !!f.baseId; // variante
  }
  const listos = filas.filter(filaLista);

  async function confirmar() {
    if (!listos.length) return notify("Marcá al menos un renglón completo");
    setSaving(true);
    try {
      await api.confirmarIngreso(ingresoId ?? "manual", destino, listos.map((f) => {
        const base = { id: f.id.startsWith("man-") ? undefined : f.id, cantidad: f.cantidad };
        if (f.modo === "existente") return { ...base, producto_id: f.producto_id!, aprender_alias: f.confianza < 0.9 ? f.descripcion : undefined };
        if (f.modo === "nuevo") return { ...base, nuevo: { sku: f.nuevoSku.trim(), nombre: (f.nuevoNombre || f.descripcion || f.nuevoSku).trim() } };
        return { ...base, variante: { sku: f.nuevoSku.trim(), nombre: (f.nuevoNombre || f.descripcion || f.nuevoSku).trim(), base_producto_id: f.baseId! } };
      }));
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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={reading}>
            {reading ? "Leyendo factura…" : "📷 Subir foto de factura / remito"}
          </button>
          <button className="btn" onClick={() => setFilas((fs) => [...fs, nuevaFila({})])}>＋ Agregar renglón a mano</button>
        </div>
        {!api.connected && <span className="muted" style={{ marginLeft: 4 }}>(en demo, usa una factura de ejemplo)</span>}
      </div>

      {filas.length > 0 && (
        <div className="card">
          <div className="card-pad" style={{ paddingBottom: 8 }}>
            <h3 style={{ fontSize: "1rem" }}>Renglones</h3>
            <p className="muted">Asigná cada renglón a un producto <b>existente</b>, o marcalo como <b>producto nuevo</b> o <b>variante</b>. La cantidad y el SKU siempre los podés corregir.</p>
          </div>
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th></th><th>Detectado</th><th style={{ minWidth: 320 }}>Producto</th>
                  <th style={{ textAlign: "right" }}>Cant.</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <tr key={f.id} style={{ background: f.confianza < 0.6 && f.modo === "existente" && !f.producto_id ? "var(--warn-wash)" : undefined }}>
                    <td><input type="checkbox" checked={f.confirmar} onChange={(e) => setFila(f.id, { confirmar: e.target.checked })} /></td>
                    <td style={{ fontSize: ".84rem", maxWidth: 200 }}>{f.descripcion || <span className="muted">(a mano)</span>}</td>
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
                        {(f.modo === "nuevo" || f.modo === "variante") && (
                          <div style={{ display: "flex", gap: 6 }}>
                            <input className="input" style={{ width: 150 }} placeholder="SKU nuevo" value={f.nuevoSku}
                              onChange={(e) => setFila(f.id, { nuevoSku: e.target.value })} />
                            <input className="input grow" placeholder="Nombre" value={f.nuevoNombre}
                              onChange={(e) => setFila(f.id, { nuevoNombre: e.target.value })} />
                          </div>
                        )}
                      </div>
                    </td>
                    <td style={{ textAlign: "right", verticalAlign: "top" }}>
                      <input className="input qtybox" type="number" min={1} value={f.cantidad}
                        onChange={(e) => setFila(f.id, { cantidad: Math.max(1, Number(e.target.value) || 1) })} />
                    </td>
                    <td style={{ verticalAlign: "top" }}>
                      <button className="btn ghost btn-sm" onClick={() => quitar(f.id)} title="Quitar renglón">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-pad between">
            <span className="muted">{listos.length} renglón(es) listos {listos.some((f) => f.modo !== "existente") && "· incluye altas nuevas"}</span>
            <button className="btn primary" onClick={confirmar} disabled={saving || !listos.length}>
              {saving ? "Confirmando…" : "Confirmar ingreso"}
            </button>
          </div>
        </div>
      )}

      <p className="muted" style={{ fontSize: ".8rem" }}>
        Los <b>productos nuevos</b> y <b>variantes</b> se crean en la app y quedan marcados como pendientes de
        alta en Contabilium (se crean allá cuando activemos la escritura). El stock queda cargado igual.
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
