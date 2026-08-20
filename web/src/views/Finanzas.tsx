import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { calcularFinanzas, type FinResultado, type FinProducto, type FinanzasConfig } from "../lib/finanzas.ts";

export type FinTab = "resumen" | "producto" | "proveedor" | "capital" | "matriz";

const money = (n?: number | null) =>
  n == null ? "—" : new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n);
const pct = (n?: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const dias = (n?: number | null) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n} d`);

export function Finanzas({ subtab, notify }: { subtab: FinTab; notify: (m: string) => void }) {
  const [res, setRes] = useState<FinResultado | null>(null);
  const [cfg, setCfg] = useState<FinanzasConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [periodo, setPeriodo] = useState(60);
  const [ajustes, setAjustes] = useState(false);
  const [serie, setSerie] = useState<{ label: string; bruto: number }[]>([]);

  async function cargar() {
    setLoading(true);
    try {
      const [config, ventas, prods, compras, devs, comis, prodFin] = await Promise.all([
        api.finanzasConfig(), api.ventasRaw(), api.productosRaw(), api.comprasDetalle(), api.devoluciones(),
        api.comisionesSku(), api.productoFinanzasAll(),
      ]);
      const c = config ?? { tasa_anual: 0.4, comision_ml: 0.14, comision_tn: 0.10, dias_cobro_ml: 14, dias_cobro_tn: 10, costo_envio_default: 0, margen_min: 0.15 };
      setCfg(c);
      const devRaw = devs.map((d) => ({ sku: d.sku, cantidad: d.cantidad, valor_perdida: d.valor_perdida, estado: d.estado }));
      // Comisión real de ML por SKU + parámetros por producto.
      const comisionSku = new Map(comis.map((x) => [String(x.sku).toLowerCase(), Number(x.comision_pct)]));
      const prodById = new Map(prods.filter((p) => p.id).map((p) => [p.id!, p]));
      const prodFinSku = new Map<string, typeof prodFin[number]>();
      for (const pf of prodFin) { const p = prodById.get(pf.producto_id); if (p) prodFinSku.set(String(p.sku).toLowerCase(), pf); }
      setRes(calcularFinanzas(ventas, prods, compras, devRaw, c, periodo, { comisionSku, prodFinSku }));

      // Serie mensual de facturación (últimos 6 meses) para el gráfico temporal.
      const now = new Date();
      const meses = Array.from({ length: 6 }, (_, i) => {
        const dt = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
        return { key: `${dt.getFullYear()}-${dt.getMonth()}`, label: dt.toLocaleDateString("es-AR", { month: "short" }), bruto: 0 };
      });
      const idx = new Map(meses.map((m, i) => [m.key, i]));
      const prodPrecio = new Map(prods.map((p) => [String(p.sku).toLowerCase(), Number(p.precio || 0)]));
      for (const v of ventas) {
        if (!v.fecha) continue;
        const dt = new Date(v.fecha); const i = idx.get(`${dt.getFullYear()}-${dt.getMonth()}`);
        if (i == null) continue;
        for (const it of v.items ?? []) {
          const m = Number(it.monto || 0) > 0 ? Number(it.monto) : (prodPrecio.get(String(it.sku).toLowerCase()) ?? 0) * Number(it.cantidad || 0);
          meses[i].bruto += m;
        }
      }
      setSerie(meses.map((m) => ({ label: m.label, bruto: Math.round(m.bruto) })));
    } catch (e) { notify("Error al calcular finanzas: " + (e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { cargar(); }, [periodo]);

  const head = (
    <div className="section-head">
      <div><span className="eyebrow">Finanzas</span><h2>{TITULOS[subtab][0]}</h2><p className="muted">{TITULOS[subtab][1]}</p></div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select className="select" style={{ width: "auto" }} value={periodo} onChange={(e) => setPeriodo(Number(e.target.value))}>
          <option value={30}>Últimos 30 días</option>
          <option value={60}>Últimos 60 días</option>
          <option value={90}>Últimos 90 días</option>
        </select>
        <button className="btn" onClick={() => setAjustes(true)} title="Ajustes de cálculo">⚙ Ajustes</button>
      </div>
    </div>
  );

  if (loading || !res || !cfg) return <div className="stack">{head}<div className="empty">Calculando…</div></div>;

  return (
    <div className="stack">
      {head}
      {subtab === "resumen" && <Resumen res={res} cfg={cfg} serie={serie} />}
      {subtab === "producto" && <PorProducto res={res} cfg={cfg} />}
      {subtab === "proveedor" && <PorProveedor res={res} />}
      {subtab === "capital" && <Capital res={res} />}
      {subtab === "matriz" && <Matriz res={res} cfg={cfg} />}
      <DataNote res={res} />
      {ajustes && <AjustesModal cfg={cfg} onClose={() => setAjustes(false)} onSaved={() => { setAjustes(false); cargar(); }} notify={notify} />}
    </div>
  );
}

// Editor de la configuración de cálculo (finanzas_config).
function AjustesModal({ cfg, onClose, onSaved, notify }: { cfg: FinanzasConfig; onClose: () => void; onSaved: () => void; notify: (m: string) => void }) {
  const [f, setF] = useState({
    comision_ml: (cfg.comision_ml * 100).toString(),
    comision_tn: (cfg.comision_tn * 100).toString(),
    dias_cobro_ml: cfg.dias_cobro_ml.toString(),
    dias_cobro_tn: cfg.dias_cobro_tn.toString(),
    tasa_anual: (cfg.tasa_anual * 100).toString(),
    margen_min: (cfg.margen_min * 100).toString(),
    costo_envio_default: (cfg.costo_envio_default ?? 0).toString(),
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function guardar() {
    setBusy(true);
    try {
      await api.guardarFinanzasConfig({
        comision_ml: Number(f.comision_ml) / 100, comision_tn: Number(f.comision_tn) / 100,
        dias_cobro_ml: Number(f.dias_cobro_ml), dias_cobro_tn: Number(f.dias_cobro_tn),
        tasa_anual: Number(f.tasa_anual) / 100, margen_min: Number(f.margen_min) / 100,
        costo_envio_default: Number(f.costo_envio_default),
      });
      notify("Ajustes guardados"); onSaved();
    } catch (e) { notify("Error: " + (e as Error).message); setBusy(false); }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: "min(520px,100%)" }}>
        <div className="modal-head"><h3>Ajustes de cálculo</h3><button className="btn ghost btn-sm" onClick={onClose}>✕</button></div>
        <p className="muted" style={{ fontSize: ".84rem", marginTop: -6, marginBottom: 12 }}>
          Valores usados cuando no hay dato real. La comisión de ML se toma automáticamente por publicación; esto es el respaldo.
        </p>
        <div className="row2">
          <div className="field"><label>Comisión ML % (respaldo)</label><input className="input" type="number" step="0.1" value={f.comision_ml} onChange={set("comision_ml")} /></div>
          <div className="field"><label>Comisión Tienda Nube %</label><input className="input" type="number" step="0.1" value={f.comision_tn} onChange={set("comision_tn")} /></div>
        </div>
        <div className="row2">
          <div className="field"><label>Días de cobro ML</label><input className="input" type="number" value={f.dias_cobro_ml} onChange={set("dias_cobro_ml")} /></div>
          <div className="field"><label>Días de cobro TN</label><input className="input" type="number" value={f.dias_cobro_tn} onChange={set("dias_cobro_tn")} /></div>
        </div>
        <div className="row2">
          <div className="field"><label>Tasa de financiación anual %</label><input className="input" type="number" step="0.1" value={f.tasa_anual} onChange={set("tasa_anual")} /></div>
          <div className="field"><label>Margen mínimo objetivo %</label><input className="input" type="number" step="0.1" value={f.margen_min} onChange={set("margen_min")} /></div>
        </div>
        <div className="field"><label>Costo de envío por unidad (si aplica)</label><input className="input" type="number" value={f.costo_envio_default} onChange={set("costo_envio_default")} /></div>
        <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} onClick={guardar} disabled={busy}>{busy ? "Guardando…" : "Guardar ajustes"}</button>
      </div>
    </div>
  );
}

const TITULOS: Record<FinTab, [string, string]> = {
  resumen: ["Rentabilidad", "Resumen ejecutivo: ganancia neta real y capital de trabajo"],
  producto: ["Por producto", "Rentabilidad y ciclo de caja de cada SKU"],
  proveedor: ["Por proveedor", "Rentabilidad agregada y autofinanciación por proveedor"],
  capital: ["Capital de trabajo", "Cuánto capital inmoviliza la operación y qué se autofinancia"],
  matriz: ["Matriz de decisión", "Rentabilidad vs capital requerido — qué escalar y qué discontinuar"],
};

function DataNote({ res }: { res: FinResultado }) {
  const { sinPrecio, sinCompra, skus } = res.empresa;
  if (!skus) return null;
  return (
    <p className="faint" style={{ fontSize: ".78rem", maxWidth: "80ch" }}>
      El ingreso bruto se estima con el precio de lista de Contabilium (cb_ventas aún no guarda el importe cobrado).
      {sinPrecio > 0 && <> {sinPrecio} SKU vendidos no tienen precio cargado.</>}
      {sinCompra > 0 && <> {sinCompra} no tienen compra con términos de pago, así que su ciclo de caja no se puede calcular todavía — se completa al cargar ingresos con condición de pago.</>}
    </p>
  );
}

function Kpi({ label, value, tone, hint }: { label: string; value: string; tone?: "ok" | "crit" | "warn"; hint?: string }) {
  return (
    <div className="card card-pad kpi" title={hint}>
      <div className="kpi-l">{label}</div>
      <div className={"fin-kpi-v " + (tone ?? "")}>{value}</div>
    </div>
  );
}

// ---- Pantalla 4: Resumen ejecutivo ----
function Resumen({ res, cfg, serie }: { res: FinResultado; cfg: FinanzasConfig; serie: { label: string; bruto: number }[] }) {
  const e = res.empresa;
  const costos = [
    { k: "Comisiones marketplace", v: e.comision, c: "#3E86FF" },
    { k: "Costo de mercadería (COGS)", v: e.cogs, c: "#12B4EF" },
    { k: "Logística y devoluciones", v: e.logistica, c: "#B0791C" },
    { k: "Costo de financiación", v: e.financiacion, c: "#D23B3B" },
  ];
  const totalCostos = costos.reduce((s, x) => s + x.v, 0) || 1;
  return (
    <>
      <div className="fin-exec">
        <div className="fin-pl card card-pad">
          <div className="fin-box-t">💰 Rentabilidad</div>
          <PlRow k="Ventas brutas (estimado)" v={money(e.bruto)} />
          <PlRow k="Comisiones marketplace" v={"-" + money(e.comision)} neg />
          <PlRow k="Costo de mercadería (COGS)" v={"-" + money(e.cogs)} neg />
          <PlRow k="Logística y devoluciones" v={"-" + money(e.logistica)} neg />
          <PlRow k="Costo de financiación" v={"-" + money(e.financiacion)} neg />
          <div className="fin-pl-total">
            <span>🎯 Ganancia neta</span>
            <b className={e.neto >= 0 ? "ok" : "crit"}>{money(e.neto)}</b>
          </div>
          <div className="fin-pl-sub">Margen neto {pct(e.margen)} · ROI {pct(e.roi)} · Devoluciones {pct(e.tasaDevolucion)}</div>
        </div>

        <div className="fin-cap card card-pad">
          <div className="fin-box-t">💳 Capital de trabajo</div>
          <PlRow k="Capital requerido (estimado)" v={money(e.capital)} />
          <PlRow k="Ciclo de caja promedio" v={dias(e.ciclo)} />
          <div className={"fin-estado " + (e.autofinancia ? "ok" : "warn")}>
            {e.ciclo == null ? "⏳ Faltan datos de compra para el ciclo"
              : e.autofinancia ? "✅ Se autofinancia" : "⚠️ Requiere capital"}
          </div>
          {e.ciclo != null && e.autofinancia && <div className="fin-pl-sub">Se cobra ~{Math.abs(e.ciclo)} días antes de pagar. Excedente estimado {money(e.excedente)}.</div>}
          <div className="fin-pl-sub" style={{ marginTop: 8 }}>Supuestos: comisión ML {pct(cfg.comision_ml)} · TN {pct(cfg.comision_tn)} · cobro ML {cfg.dias_cobro_ml}d / TN {cfg.dias_cobro_tn}d · tasa {pct(cfg.tasa_anual)}.</div>
        </div>
      </div>

      <div className="fin-exec">
        <div className="card card-pad">
          <div className="fin-box-t">Composición de costos — dónde se va el dinero</div>
          <div className="cost-bars">
            {costos.map((c) => (
              <div key={c.k} className="cost-row">
                <span className="cost-k">{c.k}</span>
                <div className="cost-track"><i style={{ width: `${(c.v / totalCostos) * 100}%`, background: c.c }} /></div>
                <span className="cost-v">{money(c.v)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card card-pad">
          <div className="fin-box-t">Facturación por mes</div>
          <MesBars serie={serie} />
        </div>
      </div>

      <div className="card card-pad">
        <div className="fin-box-t">Flujo: de la venta bruta a la ganancia neta</div>
        <Waterfall e={e} />
      </div>
    </>
  );
}

// Barras de facturación mensual (SVG simple).
function MesBars({ serie }: { serie: { label: string; bruto: number }[] }) {
  const max = Math.max(1, ...serie.map((s) => s.bruto));
  if (serie.every((s) => s.bruto === 0)) return <p className="muted">Sin ventas en el período.</p>;
  return (
    <div className="mes-bars">
      {serie.map((s, i) => (
        <div key={i} className="mes-col">
          <div className="mes-track"><i style={{ height: `${(s.bruto / max) * 100}%` }} title={money(s.bruto)} /></div>
          <span className="mes-lbl">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

// Waterfall del flujo de efectivo (bruto → neto).
function Waterfall({ e }: { e: FinResultado["empresa"] }) {
  const steps = [
    { k: "Bruto", v: e.bruto, tipo: "base" },
    { k: "Comisiones", v: -e.comision, tipo: "neg" },
    { k: "COGS", v: -e.cogs, tipo: "neg" },
    { k: "Logística/dev.", v: -e.logistica, tipo: "neg" },
    { k: "Financiación", v: -e.financiacion, tipo: "neg" },
    { k: "Neto", v: e.neto, tipo: "total" },
  ];
  const max = Math.max(1, e.bruto);
  let acum = 0;
  return (
    <div className="wf">
      {steps.map((s, i) => {
        let left: number, w: number, cls: string;
        if (s.tipo === "base") { left = 0; w = e.bruto / max; cls = "wf-base"; acum = e.bruto; }
        else if (s.tipo === "total") { left = 0; w = Math.max(0, e.neto) / max; cls = e.neto >= 0 ? "wf-total" : "wf-neg"; }
        else { const desde = acum + s.v; left = desde / max; w = (-s.v) / max; cls = "wf-neg"; acum = desde; }
        return (
          <div key={i} className="wf-row">
            <span className="wf-k">{s.k}</span>
            <div className="wf-track"><i className={cls} style={{ marginLeft: `${left * 100}%`, width: `${w * 100}%` }} /></div>
            <span className="wf-v">{money(s.v)}</span>
          </div>
        );
      })}
    </div>
  );
}
function PlRow({ k, v, neg }: { k: string; v: string; neg?: boolean }) {
  return <div className="fin-pl-row"><span>{k}</span><span className={neg ? "neg" : ""}>{v}</span></div>;
}

// ---- Pantalla 1: Por producto ----
function PorProducto({ res, cfg }: { res: FinResultado; cfg: FinanzasConfig }) {
  const [soloProblema, setSoloProblema] = useState(false);
  const [q, setQ] = useState("");
  const rows = res.productos.filter((p) => {
    if (soloProblema && !(p.bruto > 0 && p.margen < cfg.margen_min)) return false;
    if (q && !(`${p.nombre} ${p.sku}`.toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  });
  return (
    <>
      <div className="filters">
        <input className="input grow" placeholder="Buscar SKU o nombre…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="chk"><input type="checkbox" checked={soloProblema} onChange={(e) => setSoloProblema(e.target.checked)} /> Solo margen &lt; {pct(cfg.margen_min)}</label>
      </div>
      <div className="card scroll-x">
        <table className="tbl fin-tbl">
          <thead><tr>
            <th>Producto</th><th>Prov.</th><th className="r">Unid.</th><th className="r">Bruto</th>
            <th className="r">Comis.</th><th className="r">COGS</th><th className="r">Neto</th>
            <th className="r">Margen</th><th className="r">ROI</th><th className="r">Ciclo</th><th className="r">Capital</th>
          </tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.sku} className={p.bruto > 0 && p.margen < cfg.margen_min ? "fin-warn-row" : ""}>
                <td><div className="fin-name">{p.nombre}</div><div className="fin-sku">{p.sku}{p.sinPrecio && <span className="mini-tag"> sin precio</span>}</div></td>
                <td className="fin-prov">{p.proveedor === "Sin proveedor asignado" ? "—" : p.proveedor}</td>
                <td className="r tnum">{p.unidades}</td>
                <td className="r tnum">{money(p.bruto)}</td>
                <td className="r tnum neg">{money(p.comision)}</td>
                <td className="r tnum neg">{money(p.cogs)}</td>
                <td className={"r tnum " + (p.neto >= 0 ? "ok" : "crit")}>{money(p.neto)}</td>
                <td className={"r tnum " + (p.margen >= cfg.margen_min ? "ok" : "crit")}>{pct(p.margen)}</td>
                <td className="r tnum">{pct(p.roi)}</td>
                <td className={"r tnum " + (p.ciclo == null ? "" : p.ciclo < 0 ? "ok" : "warn")}>{dias(p.ciclo)}</td>
                <td className="r tnum">{p.capital > 0 ? money(p.capital) : "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={11} className="empty">Sin productos para mostrar.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---- Pantalla 2: Por proveedor ----
function PorProveedor({ res }: { res: FinResultado }) {
  const [abierto, setAbierto] = useState<string | null>(res.proveedores[0]?.proveedor ?? null);
  return (
    <div className="stack">
      {res.proveedores.map((pv) => (
        <div key={pv.proveedor} className="card prov-card">
          <button className="prov-head" onClick={() => setAbierto(abierto === pv.proveedor ? null : pv.proveedor)}>
            <div className="prov-name">{pv.proveedor}</div>
            <div className="prov-kpis">
              <span>{pv.productos} SKU</span>
              <span>Bruto {money(pv.bruto)}</span>
              <span className={pv.neto >= 0 ? "ok" : "crit"}>Neto {money(pv.neto)}</span>
              <span>Margen {pct(pv.margen)}</span>
              <span className={"prov-estado " + (pv.autofinancia ? "ok" : pv.ciclo == null ? "" : "warn")}>
                {pv.ciclo == null ? "ciclo s/datos" : pv.autofinancia ? "autofinancia" : "requiere capital"}
              </span>
            </div>
            <span className="side-chev">{abierto === pv.proveedor ? "▾" : "▸"}</span>
          </button>
          {abierto === pv.proveedor && (
            <div className="scroll-x">
              <table className="tbl fin-tbl">
                <thead><tr><th>Producto</th><th className="r">Unid.</th><th className="r">Bruto</th><th className="r">Neto</th><th className="r">Margen</th><th className="r">Ciclo</th><th className="r">Capital</th></tr></thead>
                <tbody>
                  {pv.items.map((p) => (
                    <tr key={p.sku}>
                      <td><div className="fin-name">{p.nombre}</div><div className="fin-sku">{p.sku}</div></td>
                      <td className="r tnum">{p.unidades}</td>
                      <td className="r tnum">{money(p.bruto)}</td>
                      <td className={"r tnum " + (p.neto >= 0 ? "ok" : "crit")}>{money(p.neto)}</td>
                      <td className="r tnum">{pct(p.margen)}</td>
                      <td className={"r tnum " + (p.ciclo == null ? "" : p.ciclo < 0 ? "ok" : "warn")}>{dias(p.ciclo)}</td>
                      <td className="r tnum">{p.capital > 0 ? money(p.capital) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
      {res.proveedores.length === 0 && <div className="empty">Sin datos.</div>}
    </div>
  );
}

// ---- Pantalla 3: Capital de trabajo ----
function Capital({ res }: { res: FinResultado }) {
  const e = res.empresa;
  const requieren = res.productos.filter((p) => p.ciclo != null && p.ciclo > 0).sort((a, b) => b.capital - a.capital);
  const autofin = res.productos.filter((p) => p.ciclo != null && p.ciclo < 0);
  const sinDatos = res.productos.filter((p) => p.ciclo == null && p.bruto > 0);
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Capital requerido (pico)" value={money(e.capital)} tone={e.capital > 0 ? "warn" : "ok"} />
        <Kpi label="Ciclo de caja promedio" value={dias(e.ciclo)} />
        <Kpi label="Se autofinancian" value={`${autofin.length} SKU`} tone="ok" />
        <Kpi label="Requieren capital" value={`${requieren.length} SKU`} tone={requieren.length ? "warn" : "ok"} />
      </div>

      {res.proveedores.some((p) => p.ciclo != null) && (
        <div className="card card-pad">
          <div className="fin-box-t">Ciclo de caja por proveedor (negativo = se autofinancia)</div>
          <CicloProvBars proveedores={res.proveedores} />
        </div>
      )}

      <div className="card card-pad">
        <div className="fin-box-t">Productos que requieren capital (pagás antes de cobrar)</div>
        {requieren.length === 0 ? <p className="muted">Ninguno con datos de compra cargados. {sinDatos.length > 0 && `(${sinDatos.length} SKU sin términos de pago aún.)`}</p> : (
          <div className="scroll-x"><table className="tbl fin-tbl">
            <thead><tr><th>Producto</th><th className="r">Ciclo</th><th className="r">Capital</th><th className="r">Financiación</th></tr></thead>
            <tbody>{requieren.map((p) => (
              <tr key={p.sku}><td><div className="fin-name">{p.nombre}</div><div className="fin-sku">{p.sku}</div></td>
                <td className="r tnum warn">{dias(p.ciclo)}</td><td className="r tnum">{money(p.capital)}</td><td className="r tnum">{money(p.financiacion)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      <div className="card card-pad">
        <div className="fin-box-t">Se autofinancian (cobrás antes de pagar)</div>
        {autofin.length === 0 ? <p className="muted">Todavía sin datos de compra para confirmar autofinanciación.</p> : (
          <div className="chips">{autofin.slice(0, 40).map((p) => <span key={p.sku} className="chip">{p.nombre} <b className="ok">{dias(p.ciclo)}</b></span>)}</div>
        )}
      </div>
    </div>
  );
}

// Barras divergentes de ciclo de caja por proveedor.
function CicloProvBars({ proveedores }: { proveedores: FinResultado["proveedores"] }) {
  const rows = proveedores.filter((p) => p.ciclo != null);
  const max = Math.max(1, ...rows.map((p) => Math.abs(p.ciclo!)));
  return (
    <div className="ciclo-bars">
      {rows.map((p) => {
        const w = (Math.abs(p.ciclo!) / max) * 50;
        const neg = p.ciclo! < 0;
        return (
          <div key={p.proveedor} className="ciclo-row">
            <span className="ciclo-name">{p.proveedor}</span>
            <div className="ciclo-track">
              <div className="ciclo-mid" />
              <i className={neg ? "neg" : "pos"} style={{ [neg ? "right" : "left"]: "50%", width: `${w}%` } as React.CSSProperties} />
            </div>
            <span className={"ciclo-v " + (neg ? "ok" : "warn")}>{dias(p.ciclo)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---- Pantalla 5: Matriz de decisión ----
function Matriz({ res, cfg }: { res: FinResultado; cfg: FinanzasConfig }) {
  const q = (c: FinProducto["cuadrante"]) => res.productos.filter((p) => p.cuadrante === c);
  const cuad = [
    { id: "A", t: "Ideal ✅", d: "Rentable y se autofinancia", act: "Aumentar volumen de compras", cls: "q-a" },
    { id: "B", t: "Alerta ⚠️", d: "Rentable pero requiere capital", act: "Ver si el costo de financiación vale la pena", cls: "q-b" },
    { id: "C", t: "Revisar 🔍", d: "Se autofinancia pero poco rentable", act: "Renegociar precio de compra o dar de baja", cls: "q-c" },
    { id: "D", t: "Eliminar ❌", d: "Poco rentable y requiere capital", act: "Dejar de vender (dinero atrapado)", cls: "q-d" },
  ] as const;
  const sinClasif = res.productos.filter((p) => p.cuadrante == null && p.bruto > 0);
  return (
    <>
      <p className="muted" style={{ maxWidth: "72ch" }}>Cruce de <b>margen neto</b> (umbral {pct(cfg.margen_min)}) con el <b>ciclo de caja</b>. Los productos sin términos de compra cargados quedan sin clasificar hasta tener ese dato.</p>
      <div className="matriz">
        {cuad.map((c) => {
          const items = q(c.id as FinProducto["cuadrante"]);
          return (
            <div key={c.id} className={"matriz-q " + c.cls}>
              <div className="matriz-h"><b>Cuadrante {c.id}: {c.t}</b><span>{items.length}</span></div>
              <div className="matriz-d">{c.d}</div>
              <div className="matriz-act">→ {c.act}</div>
              <div className="matriz-items">
                {items.slice(0, 8).map((p) => <span key={p.sku} className="chip">{p.nombre} · {pct(p.margen)} · {dias(p.ciclo)}</span>)}
                {items.length === 0 && <span className="faint">—</span>}
              </div>
            </div>
          );
        })}
      </div>
      {sinClasif.length > 0 && <p className="faint" style={{ fontSize: ".78rem" }}>{sinClasif.length} productos con ventas pero sin términos de compra: no se pueden ubicar en la matriz todavía.</p>}
    </>
  );
}
