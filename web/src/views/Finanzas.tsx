import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import {
  calcularFinanzas, simularML, resumenAcreditacion, mapsDeOrdenes,
  type FinResultado, type FinProducto, type FinanzasConfig, type ProdRaw, type Acreditacion,
} from "../lib/finanzas.ts";

export type FinTab = "resumen" | "producto" | "proveedor" | "capital" | "matriz" | "proyeccion";

const money = (n?: number | null) =>
  n == null ? "—" : new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n);
const pct = (n?: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const dias = (n?: number | null) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n} d`);

const CFG_DEFAULT: FinanzasConfig = {
  tasa_anual: 0.4, comision_ml: 0.14, comision_tn: 0.10, dias_cobro_ml: 14, dias_cobro_tn: 10,
  costo_envio_default: 0, margen_min: 0.15,
  percepciones_pct: 0, financiacion_mp_pct: 0, tn_gasto_pct: 0.15, envio_full_default: 0,
};

export function Finanzas({ subtab, notify }: { subtab: FinTab; notify: (m: string) => void }) {
  const [res, setRes] = useState<FinResultado | null>(null);
  const [cfg, setCfg] = useState<FinanzasConfig | null>(null);
  const [prods, setProds] = useState<ProdRaw[]>([]);
  const [loading, setLoading] = useState(true);
  const [periodo, setPeriodo] = useState(60);
  const [ajustes, setAjustes] = useState(false);
  const [serie, setSerie] = useState<{ label: string; bruto: number }[]>([]);
  const [detalle, setDetalle] = useState<FinProducto | null>(null);
  const [proyModal, setProyModal] = useState(false);
  const [acred, setAcred] = useState<Acreditacion | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Mapa sku(lower) → producto_id, para editar producto_finanzas desde el detalle.
  const prodIdBySku = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of prods) if (p.id) m.set(String(p.sku).toLowerCase(), p.id);
    return m;
  }, [prods]);

  async function cargar() {
    setLoading(true);
    try {
      const [config, ventas, prds, compras, devs, comis, prodFin, ordenes, ads] = await Promise.all([
        api.finanzasConfig(), api.ventasRaw(), api.productosRaw(), api.comprasDetalle(), api.devoluciones(),
        api.comisionesSku(), api.productoFinanzasAll(), api.mlOrdenes(), api.adsSku(30),
      ]);
      const c: FinanzasConfig = { ...CFG_DEFAULT, ...(config ?? {}) };
      setCfg(c); setProds(prds);
      const devRaw = devs.map((d) => ({ sku: d.sku, cantidad: d.cantidad, valor_perdida: d.valor_perdida, estado: d.estado }));
      const comisionSku = new Map(comis.map((x) => [String(x.sku).toLowerCase(), Number(x.comision_pct)]));
      const prodById = new Map(prds.filter((p) => p.id).map((p) => [p.id!, p]));
      const prodFinSku = new Map<string, typeof prodFin[number]>();
      for (const pf of prodFin) { const p = prodById.get(pf.producto_id); if (p) prodFinSku.set(String(p.sku).toLowerCase(), pf); }
      // Datos reales de Mercado Libre por SKU (comisión, logística) + inversión en ads.
      const { feeRealSku, envioRealSku } = mapsDeOrdenes(ordenes, periodo);
      setAcred(resumenAcreditacion(ordenes, periodo));
      setRes(calcularFinanzas(ventas, prds, compras, devRaw, c, periodo, { comisionSku, prodFinSku, feeRealSku, envioRealSku, adsSku: ads }));

      // Serie mensual de facturación (últimos 6 meses).
      const now = new Date();
      const meses = Array.from({ length: 6 }, (_, i) => {
        const dt = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
        return { key: `${dt.getFullYear()}-${dt.getMonth()}`, label: dt.toLocaleDateString("es-AR", { month: "short" }), bruto: 0 };
      });
      const idx = new Map(meses.map((m, i) => [m.key, i]));
      const prodPrecio = new Map(prds.map((p) => [String(p.sku).toLowerCase(), Number(p.precio || 0)]));
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

  async function sincronizarML() {
    setSyncing(true);
    try {
      notify("Sincronizando órdenes y ads de Mercado Libre… puede tardar.");
      await Promise.all([api.syncMlOrdenes(periodo), api.syncMlAds(30)]);
      notify("Datos de Mercado Libre actualizados");
      await cargar();
    } catch (e) { notify("Error al sincronizar ML: " + (e as Error).message); }
    finally { setSyncing(false); }
  }

  const head = (
    <div className="section-head">
      <div><span className="eyebrow">Finanzas</span><h2>{TITULOS[subtab][0]}</h2><p className="muted">{TITULOS[subtab][1]}</p></div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {subtab === "proyeccion" && <button className="btn primary" onClick={() => setProyModal(true)}>＋ Proyección</button>}
        {(subtab === "capital" || subtab === "resumen") && <button className="btn" onClick={sincronizarML} disabled={syncing} title="Trae órdenes (acreditación, envío, comisión real) e inversión de ads de Mercado Libre">{syncing ? "Sincronizando…" : "🔄 Sincronizar ML"}</button>}
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
      {subtab === "producto" && <PorProducto res={res} cfg={cfg} onSelect={setDetalle} />}
      {subtab === "proveedor" && <PorProveedor res={res} />}
      {subtab === "capital" && <Capital res={res} acred={acred} />}
      {subtab === "matriz" && <Matriz res={res} cfg={cfg} />}
      {subtab === "proyeccion" && <Proyeccion res={res} cfg={cfg} prods={prods} />}
      <DataNote res={res} cfg={cfg} />
      {ajustes && <AjustesModal cfg={cfg} onClose={() => setAjustes(false)} onSaved={() => { setAjustes(false); cargar(); }} notify={notify} />}
      {detalle && (
        <ProductoDrawer
          p={detalle} cfg={cfg}
          productoId={prodIdBySku.get(detalle.sku.toLowerCase()) ?? null}
          costoCB={prods.find((x) => x.sku.toLowerCase() === detalle.sku.toLowerCase())?.costo ?? null}
          onClose={() => setDetalle(null)} onSaved={() => { setDetalle(null); cargar(); }} notify={notify}
        />
      )}
      {proyModal && <SimuladorModal cfg={cfg} prods={prods} onClose={() => setProyModal(false)} />}
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
    envio_full_default: (cfg.envio_full_default ?? 0).toString(),
    percepciones_pct: ((cfg.percepciones_pct ?? 0) * 100).toString(),
    financiacion_mp_pct: ((cfg.financiacion_mp_pct ?? 0) * 100).toString(),
    tn_gasto_pct: ((cfg.tn_gasto_pct ?? 0.15) * 100).toString(),
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
        envio_full_default: Number(f.envio_full_default),
        percepciones_pct: Number(f.percepciones_pct) / 100,
        financiacion_mp_pct: Number(f.financiacion_mp_pct) / 100,
        tn_gasto_pct: Number(f.tn_gasto_pct) / 100,
      });
      notify("Ajustes guardados"); onSaved();
    } catch (e) { notify("Error: " + (e as Error).message); setBusy(false); }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: "min(560px,100%)" }}>
        <div className="modal-head"><h3>Ajustes de cálculo</h3><button className="btn ghost btn-sm" onClick={onClose}>✕</button></div>
        <p className="muted" style={{ fontSize: ".84rem", marginTop: -6, marginBottom: 12 }}>
          Valores usados cuando no hay dato real. La comisión de ML se toma automáticamente por publicación; esto es el respaldo.
        </p>
        <div className="row2">
          <div className="field"><label>Comisión ML % (respaldo)</label><input className="input" type="number" step="0.1" value={f.comision_ml} onChange={set("comision_ml")} /></div>
          <div className="field"><label>Días de cobro ML</label><input className="input" type="number" value={f.dias_cobro_ml} onChange={set("dias_cobro_ml")} /></div>
        </div>
        <div className="row2">
          <div className="field"><label>Envío Full por unidad</label><input className="input" type="number" value={f.envio_full_default} onChange={set("envio_full_default")} /></div>
          <div className="field"><label>Percepciones/AFIP % (ML)</label><input className="input" type="number" step="0.1" value={f.percepciones_pct} onChange={set("percepciones_pct")} /></div>
        </div>
        <div className="row2">
          <div className="field"><label>Financiación MP % (si aplica)</label><input className="input" type="number" step="0.1" value={f.financiacion_mp_pct} onChange={set("financiacion_mp_pct")} /></div>
          <div className="field"><label>Tasa de financiación anual %</label><input className="input" type="number" step="0.1" value={f.tasa_anual} onChange={set("tasa_anual")} /></div>
        </div>
        <div className="fin-sep">Tienda Nube <span className="mini-tag warn">aproximado (sin API)</span></div>
        <div className="row2">
          <div className="field"><label>Gasto total TN % (aprox.)</label><input className="input" type="number" step="0.1" value={f.tn_gasto_pct} onChange={set("tn_gasto_pct")} /></div>
          <div className="field"><label>Comisión TN % (para P&amp;L)</label><input className="input" type="number" step="0.1" value={f.comision_tn} onChange={set("comision_tn")} /></div>
        </div>
        <div className="row2">
          <div className="field"><label>Días de cobro TN</label><input className="input" type="number" value={f.dias_cobro_tn} onChange={set("dias_cobro_tn")} /></div>
          <div className="field"><label>Margen mínimo objetivo %</label><input className="input" type="number" step="0.1" value={f.margen_min} onChange={set("margen_min")} /></div>
        </div>
        <button className="btn primary" style={{ width: "100%", justifyContent: "center", marginTop: 6 }} onClick={guardar} disabled={busy}>{busy ? "Guardando…" : "Guardar ajustes"}</button>
      </div>
    </div>
  );
}

const TITULOS: Record<FinTab, [string, string]> = {
  resumen: ["Rentabilidad", "Resumen ejecutivo: ganancia neta real y capital de trabajo"],
  producto: ["Por producto", "Rentabilidad y ciclo de caja de cada SKU — hacé click para el desglose"],
  proveedor: ["Por proveedor", "Rentabilidad agregada y autofinanciación por proveedor"],
  capital: ["Capital de trabajo", "Capital requerido vs. disponible por SKU y proveedor"],
  matriz: ["Matriz de decisión", "Rentabilidad vs capital requerido — qué escalar y qué discontinuar"],
  proyeccion: ["Proyección", "Simulá cuánto deja un SKU (o varios) antes de vender"],
};

function DataNote({ res, cfg }: { res: FinResultado; cfg: FinanzasConfig }) {
  const { sinPrecio, sinCompra, skus, brutoTn } = res.empresa;
  if (!skus) return null;
  return (
    <p className="faint" style={{ fontSize: ".78rem", maxWidth: "84ch" }}>
      Mercado Libre se calcula con datos reales (comisión por publicación, importes de Contabilium).
      {brutoTn > 0 && <> Tienda Nube es <b>aproximado</b>: sus gastos se estiman en {pct(cfg.tn_gasto_pct)} fijo (no hay API).</>}
      {sinPrecio > 0 && <> {sinPrecio} SKU vendidos no tienen precio cargado.</>}
      {sinCompra > 0 && <> {sinCompra} no tienen términos de pago, así que su ciclo de caja no se calcula todavía — se completa al cargar ingresos con condición de pago.</>}
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

// ---- Resumen ejecutivo ----
function Resumen({ res, cfg, serie }: { res: FinResultado; cfg: FinanzasConfig; serie: { label: string; bruto: number }[] }) {
  const e = res.empresa;
  const costos = [
    { k: "Comisiones marketplace", v: e.comision, c: "#3E86FF" },
    { k: "Costo de mercadería (COGS)", v: e.cogs, c: "#12B4EF" },
    { k: "Logística (envíos + dev.)", v: e.logistica, c: "#B0791C" },
    { k: "Publicidad (Mercado Ads)", v: e.ads, c: "#F59E0B" },
    { k: "Percepciones / impuestos", v: e.percepciones, c: "#8B5CF6" },
    { k: "Financiación MP", v: e.financiacionMp, c: "#EC4899" },
    { k: "Gasto TN (aprox.)", v: e.gastoTn, c: "#64748B" },
    { k: "Costo de financiación (ciclo)", v: e.financiacion, c: "#D23B3B" },
  ].filter((x) => x.v > 0);
  const totalCostos = costos.reduce((s, x) => s + x.v, 0) || 1;
  return (
    <>
      <div className="fin-exec">
        <div className="fin-pl card card-pad">
          <div className="fin-box-t">💰 Rentabilidad</div>
          <PlRow k="Ventas brutas" v={money(e.bruto)} />
          <PlRow k="Comisiones marketplace" v={"-" + money(e.comision)} neg />
          <PlRow k="Costo de mercadería (COGS)" v={"-" + money(e.cogs)} neg />
          <PlRow k="Logística (envíos + dev.)" v={"-" + money(e.logistica)} neg />
          {e.ads > 0 && <PlRow k="Publicidad (Mercado Ads)" v={"-" + money(e.ads)} neg />}
          {e.percepciones > 0 && <PlRow k="Percepciones / impuestos" v={"-" + money(e.percepciones)} neg />}
          {e.financiacionMp > 0 && <PlRow k="Financiación MP" v={"-" + money(e.financiacionMp)} neg />}
          {e.gastoTn > 0 && <PlRow k="Gasto Tienda Nube (aprox.)" v={"-" + money(e.gastoTn)} neg />}
          <PlRow k="Costo de financiación (ciclo)" v={"-" + money(e.financiacion)} neg />
          <div className="fin-pl-total">
            <span>🎯 Ganancia neta</span>
            <b className={e.neto >= 0 ? "ok" : "crit"}>{money(e.neto)}</b>
          </div>
          <div className="fin-pl-sub">Margen neto {pct(e.margen)} · ROI {pct(e.roi)} · Devoluciones {pct(e.tasaDevolucion)}</div>
          {e.brutoTn > 0 && <div className="fin-warn-note">⚠️ Incluye Tienda Nube ({money(e.brutoTn)}) con gasto estimado {pct(cfg.tn_gasto_pct)} — aproximado.</div>}
        </div>

        <div className="fin-cap card card-pad">
          <div className="fin-box-t">💳 Capital de trabajo</div>
          <PlRow k="Capital requerido" v={money(e.capital)} />
          <PlRow k="Capital que se libera (autofinanciado)" v={money(e.capitalDisponible)} />
          <div className="fin-pl-total"><span>Capital neto</span><b className={e.capitalNeto <= 0 ? "ok" : "warn"}>{money(e.capitalNeto)}</b></div>
          <PlRow k="Ciclo de caja promedio" v={dias(e.ciclo)} />
          <div className={"fin-estado " + (e.autofinancia ? "ok" : "warn")}>
            {e.ciclo == null ? "⏳ Faltan datos de compra para el ciclo"
              : e.autofinancia ? "✅ Se autofinancia" : "⚠️ Requiere capital"}
          </div>
          <div className="fin-pl-sub" style={{ marginTop: 8 }}>Supuestos: comisión ML {pct(cfg.comision_ml)} · cobro ML {cfg.dias_cobro_ml}d / TN {cfg.dias_cobro_tn}d · tasa {pct(cfg.tasa_anual)}.</div>
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

function Waterfall({ e }: { e: FinResultado["empresa"] }) {
  const otros = e.percepciones + e.financiacionMp + e.gastoTn + e.ads;
  const steps = [
    { k: "Bruto", v: e.bruto, tipo: "base" },
    { k: "Comisiones", v: -e.comision, tipo: "neg" },
    { k: "COGS", v: -e.cogs, tipo: "neg" },
    { k: "Logística", v: -e.logistica, tipo: "neg" },
    { k: "Impuestos/otros", v: -otros, tipo: "neg" },
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

// ---- Por producto (con click → detalle) ----
function PorProducto({ res, cfg, onSelect }: { res: FinResultado; cfg: FinanzasConfig; onSelect: (p: FinProducto) => void }) {
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
            <th>Producto</th><th>Canal</th><th className="r">Unid.</th><th className="r">Bruto</th>
            <th className="r">Comis.</th><th className="r">COGS</th><th className="r">Neto</th>
            <th className="r">Margen</th><th className="r">ROI</th><th className="r">Ciclo</th><th className="r">Capital</th>
          </tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.sku} className={"fin-clickable " + (p.bruto > 0 && p.margen < cfg.margen_min ? "fin-warn-row" : "")} onClick={() => onSelect(p)}>
                <td><div className="fin-name">{p.nombre}</div><div className="fin-sku">{p.sku}{p.sinPrecio && <span className="mini-tag"> sin precio</span>}{p.precioCompraApp && <span className="mini-tag ok"> compra app</span>}</div></td>
                <td><span className={"canal-tag " + p.canal.toLowerCase()}>{p.canal}</span></td>
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

// ---- Detalle de un SKU (desglose + edición de condiciones de compra) ----
function ProductoDrawer({ p, cfg, productoId, costoCB, onClose, onSaved, notify }: {
  p: FinProducto; cfg: FinanzasConfig; productoId: string | null; costoCB: number | null;
  onClose: () => void; onSaved: () => void; notify: (m: string) => void;
}) {
  const [f, setF] = useState({ proveedor: "", precio_compra: "", condicion_pago_dias: "0", condOtra: "", tasa_financiacion: "", envio_flex: "" });
  const [busy, setBusy] = useState(false);
  const [confirmCB, setConfirmCB] = useState(false);
  useEffect(() => {
    if (!productoId) return;
    api.productoFinanzas(productoId).then((r) => {
      if (!r) return;
      const std = ["0", "30", "60", "90"].includes(String(r.condicion_pago_dias ?? 0));
      setF({
        proveedor: r.proveedor ?? "",
        precio_compra: r.precio_compra != null ? String(r.precio_compra) : "",
        condicion_pago_dias: std ? String(r.condicion_pago_dias ?? 0) : "otra",
        condOtra: std ? "" : String(r.condicion_pago_dias ?? 0),
        tasa_financiacion: r.tasa_financiacion ? String(r.tasa_financiacion) : "",
        envio_flex: r.envio_flex != null && r.envio_flex !== 0 ? String(r.envio_flex) : "",
      });
    }).catch(() => {});
  }, [productoId]);

  const costos = [
    { k: "Comisión marketplace" + (p.comisionReal ? " (real ML)" : ""), v: p.comision },
    { k: "Costo de mercadería (COGS)", v: p.cogs },
    { k: "Envío Full" + (p.envioReal ? " (real ML)" : ""), v: p.envioFull },
    { k: "Envío Flex (manual)", v: p.envioFlex },
    { k: "Publicidad (Mercado Ads)", v: p.ads },
    { k: "Percepciones / impuestos", v: p.percepciones },
    { k: "Financiación MP", v: p.financiacionMp },
    { k: "Gasto Tienda Nube (aprox.)", v: p.gastoTn },
    { k: "Devoluciones", v: p.devoluciones },
    { k: "Costo de financiación (ciclo)", v: p.financiacion },
  ].filter((x) => x.v > 0);

  function diasReales() {
    return f.condicion_pago_dias === "otra" ? (Number(f.condOtra) || 0) : Number(f.condicion_pago_dias) || 0;
  }
  async function persistir() {
    if (!productoId) { notify("Este SKU no tiene producto asociado para guardar."); return; }
    setBusy(true);
    try {
      await api.guardarProductoFinanzas(productoId, {
        proveedor: f.proveedor.trim() || null,
        precio_compra: f.precio_compra ? Number(f.precio_compra) : null,
        condicion_pago_dias: diasReales(),
        condicion_pago_label: f.condicion_pago_dias === "otra" ? "Otra" : null,
        tasa_financiacion: Number(f.tasa_financiacion) || 0,
        envio_flex: f.envio_flex ? Number(f.envio_flex) : 0,
      });
      notify(`Condiciones de ${p.sku} guardadas`); onSaved();
    } catch (e) { notify("No se pudo guardar: " + (e as Error).message); setBusy(false); }
  }
  // Feedback: el precio de compra de la app es la autoridad. Si cambió respecto
  // del costo de Contabilium, preguntamos si además querés escribirlo allá.
  function guardar() {
    const nuevo = f.precio_compra ? Number(f.precio_compra) : null;
    const difiereCB = nuevo != null && costoCB != null && Math.abs(nuevo - costoCB) > 0.005;
    if (difiereCB) { setConfirmCB(true); return; }
    persistir();
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: "min(640px,100%)" }}>
        <div className="modal-head">
          <div><span className="eyebrow">Detalle · {p.canal}</span><h3 style={{ margin: "2px 0 0" }}>{p.nombre}</h3><small className="muted">{p.sku}</small></div>
          <button className="btn ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        <div className="fin-exec" style={{ marginTop: 4 }}>
          <div className="card card-pad">
            <div className="fin-box-t">Desglose de la venta ({p.unidades} u.)</div>
            <PlRow k="Ventas brutas" v={money(p.bruto)} />
            {costos.map((c) => <PlRow key={c.k} k={c.k} v={"-" + money(c.v)} neg />)}
            <div className="fin-pl-total"><span>Ganancia neta</span><b className={p.neto >= 0 ? "ok" : "crit"}>{money(p.neto)}</b></div>
            <div className="fin-pl-sub">Margen {pct(p.margen)} · ROI {pct(p.roi)} · Devoluciones {pct(p.tasaDevolucion)}</div>
            {p.brutoTn > 0 && <div className="fin-warn-note">⚠️ Parte en Tienda Nube ({money(p.brutoTn)}) — gasto estimado {pct(cfg.tn_gasto_pct)}.</div>}
          </div>
          <div className="card card-pad">
            <div className="fin-box-t">Ciclo de caja</div>
            <PlRow k="Ciclo" v={dias(p.ciclo)} />
            <PlRow k="Capital requerido" v={p.capital > 0 ? money(p.capital) : "—"} />
            <PlRow k="Capital que libera" v={p.capitalNeto < 0 ? money(-p.capitalNeto) : "—"} />
            <div className={"fin-estado " + (p.autofinancia ? "ok" : p.ciclo == null ? "" : "warn")}>
              {p.ciclo == null ? "⏳ Falta condición de compra" : p.autofinancia ? "✅ Se autofinancia" : "⚠️ Requiere capital"}
            </div>
          </div>
        </div>

        <div className="det-block" style={{ marginTop: 4 }}>
          <h4>Condición de compra</h4>
          <p className="muted" style={{ fontSize: ".76rem", marginTop: 0 }}>
            El precio de compra cargado acá es la <b>autoridad</b> para el COGS.
            {costoCB != null && <> Contabilium tiene costo <b className="mono">{money(costoCB)}</b>.</>}
          </p>
          <div className="row2">
            <div className="field" style={{ marginBottom: 0 }}><label>Proveedor</label>
              <input className="input" value={f.proveedor} onChange={(e) => setF({ ...f, proveedor: e.target.value })} placeholder="Maty, LBS…" /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>Precio de compra (unit.)</label>
              <input className="input" type="number" value={f.precio_compra} onChange={(e) => setF({ ...f, precio_compra: e.target.value })} placeholder={costoCB != null ? String(costoCB) : "0"} /></div>
          </div>
          <div className="row2">
            <div className="field" style={{ marginBottom: 0 }}><label>Condición de pago</label>
              <select className="select" value={f.condicion_pago_dias} onChange={(e) => setF({ ...f, condicion_pago_dias: e.target.value })}>
                <option value="0">Contado</option><option value="30">30 días</option><option value="60">60 días</option><option value="90">90 días</option>
                <option value="otra">Otra (especificar)</option>
              </select></div>
            {f.condicion_pago_dias === "otra"
              ? <div className="field" style={{ marginBottom: 0 }}><label>Días</label><input className="input" type="number" value={f.condOtra} onChange={(e) => setF({ ...f, condOtra: e.target.value })} placeholder="ej: 45" /></div>
              : <div className="field" style={{ marginBottom: 0 }}><label>Tasa financiación anual %</label><input className="input" type="number" step="0.1" value={f.tasa_financiacion} onChange={(e) => setF({ ...f, tasa_financiacion: e.target.value })} placeholder="opcional" /></div>}
          </div>
          <div className="row2">
            {f.condicion_pago_dias === "otra" &&
              <div className="field" style={{ marginBottom: 0 }}><label>Tasa financiación anual %</label><input className="input" type="number" step="0.1" value={f.tasa_financiacion} onChange={(e) => setF({ ...f, tasa_financiacion: e.target.value })} placeholder="opcional" /></div>}
            <div className="field" style={{ marginBottom: 0 }}><label>Envío Flex por unidad <span className="muted">(manual)</span></label>
              <input className="input" type="number" value={f.envio_flex} onChange={(e) => setF({ ...f, envio_flex: e.target.value })} placeholder="ej: 400" /></div>
          </div>
          <button className="btn primary" style={{ marginTop: 10 }} onClick={guardar} disabled={busy}>{busy ? "Guardando…" : "Guardar condiciones"}</button>
        </div>
      </div>

      {confirmCB && (
        <div className="modal-bg" onClick={() => setConfirmCB(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: "min(440px,100%)" }}>
            <div className="modal-head"><h3>Modificar precio en Contabilium</h3></div>
            <p className="muted" style={{ fontSize: ".9rem" }}>
              El precio de compra ({money(Number(f.precio_compra))}) difiere del costo en Contabilium ({money(costoCB)}).
              ¿Desea modificar también el precio de compra en Contabilium?
            </p>
            <div className="fin-warn-note" style={{ marginTop: 8 }}>
              La escritura a Contabilium está en <b>modo seguro (DRY-RUN)</b> hasta activarla. Por ahora se guarda en la app; el cambio a Contabilium queda pendiente de activar el path de escritura.
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button className="btn" style={{ flex: 1, justifyContent: "center" }} onClick={() => { setConfirmCB(false); persistir(); }}>Solo en la app</button>
              <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={() => { setConfirmCB(false); persistir(); }}>Sí, también en Contabilium</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Por proveedor ----
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

// ---- Capital de trabajo (requerido vs disponible + filtros + export) ----
function Capital({ res, acred }: { res: FinResultado; acred: Acreditacion | null }) {
  const e = res.empresa;
  const [signo, setSigno] = useState<"todos" | "pos" | "neg">("todos");
  const [canal, setCanal] = useState<"todos" | "ML" | "TN" | "Ambos">("todos");

  const conCiclo = res.productos.filter((p) => p.ciclo != null);
  const rows = conCiclo.filter((p) => {
    if (signo === "pos" && !(p.capitalNeto > 0)) return false;
    if (signo === "neg" && !(p.capitalNeto < 0)) return false;
    if (canal !== "todos" && p.canal !== canal) return false;
    return true;
  }).sort((a, b) => b.capitalNeto - a.capitalNeto);
  const sinDatos = res.productos.filter((p) => p.ciclo == null && p.bruto > 0);

  function exportar() {
    const head = ["SKU", "Nombre", "Proveedor", "Canal", "Unidades", "Bruto", "Neto", "Margen%", "Ciclo(d)", "CapitalNeto", "TasaDevolucion%"];
    const lines = rows.map((p) => [
      p.sku, `"${p.nombre.replace(/"/g, '""')}"`, `"${p.proveedor}"`, p.canal, p.unidades,
      Math.round(p.bruto), Math.round(p.neto), (p.margen * 100).toFixed(1), p.ciclo ?? "",
      Math.round(p.capitalNeto), (p.tasaDevolucion * 100).toFixed(1),
    ].join(","));
    const csv = [head.join(","), ...lines].join("\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `capital_por_sku_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Capital requerido" value={money(e.capital)} tone={e.capital > 0 ? "warn" : "ok"} hint="Suma de SKU que pagás antes de cobrar" />
        <Kpi label="Capital que se libera" value={money(e.capitalDisponible)} tone="ok" hint="SKU que cobrás antes de pagar (autofinanciados)" />
        <Kpi label="Capital neto" value={money(e.capitalNeto)} tone={e.capitalNeto <= 0 ? "ok" : "warn"} />
        <Kpi label="Ciclo de caja promedio" value={dias(e.ciclo)} />
      </div>

      {acred && acred.total > 0 && (
        <div className="card card-pad">
          <div className="fin-box-t">Acreditación de Mercado Libre — capital disponible vs. pendiente</div>
          <p className="muted" style={{ fontSize: ".78rem", marginTop: -2 }}>
            De {acred.ordenes} órdenes ML sincronizadas: lo <b>acreditado</b> ya está disponible en Mercado Pago; lo <b>pendiente</b> todavía no se liberó.
          </p>
          <div className="kpis">
            <Kpi label="Ya acreditado (disponible)" value={money(acred.acreditado)} tone="ok" hint={`${acred.ordenesAcred} órdenes liberadas`} />
            <Kpi label="Pendiente de acreditar" value={money(acred.pendiente)} tone="warn" hint={`${acred.ordenes - acred.ordenesAcred} órdenes sin liberar`} />
            <Kpi label="Total en tránsito" value={money(acred.total)} />
            <Kpi label="% ya disponible" value={pct(acred.total > 0 ? acred.acreditado / acred.total : 0)} tone="ok" />
          </div>
          <AcredBar acreditado={acred.acreditado} pendiente={acred.pendiente} />
        </div>
      )}

      {res.proveedores.some((p) => p.ciclo != null) && (
        <div className="card card-pad">
          <div className="fin-box-t">Ciclo de caja por proveedor (negativo = se autofinancia)</div>
          <CicloProvBars proveedores={res.proveedores} />
        </div>
      )}

      <div className="filters">
        <div className="segbar">
          {(["todos", "pos", "neg"] as const).map((s) => (
            <button key={s} className={"seg" + (signo === s ? " on" : "")} onClick={() => setSigno(s)}>
              {s === "todos" ? "Todos" : s === "pos" ? "Requieren capital" : "Se autofinancian"}
            </button>
          ))}
        </div>
        <select className="select" style={{ width: "auto" }} value={canal} onChange={(e) => setCanal(e.target.value as typeof canal)}>
          <option value="todos">Todos los canales</option>
          <option value="ML">Mercado Libre</option>
          <option value="TN">Tienda Nube</option>
          <option value="Ambos">Ambos</option>
        </select>
        <button className="btn" onClick={exportar} disabled={rows.length === 0}>⬇ Exportar CSV</button>
      </div>

      <div className="card scroll-x">
        <table className="tbl fin-tbl">
          <thead><tr>
            <th>Producto</th><th>Prov.</th><th>Canal</th><th className="r">Ciclo</th>
            <th className="r">Capital neto</th><th className="r">Margen</th><th className="r">T. dev.</th>
          </tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.sku}>
                <td><div className="fin-name">{p.nombre}</div><div className="fin-sku">{p.sku}</div></td>
                <td className="fin-prov">{p.proveedor === "Sin proveedor asignado" ? "—" : p.proveedor}</td>
                <td><span className={"canal-tag " + p.canal.toLowerCase()}>{p.canal}</span></td>
                <td className={"r tnum " + (p.ciclo != null && p.ciclo < 0 ? "ok" : "warn")}>{dias(p.ciclo)}</td>
                <td className={"r tnum " + (p.capitalNeto <= 0 ? "ok" : "warn")}>{p.capitalNeto < 0 ? "" : "+"}{money(p.capitalNeto)}</td>
                <td className="r tnum">{pct(p.margen)}</td>
                <td className={"r tnum " + (p.tasaDevolucion > 0.05 ? "crit" : "")}>{pct(p.tasaDevolucion)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="empty">Sin SKU con datos de compra para el filtro. {sinDatos.length > 0 && `(${sinDatos.length} sin términos de pago aún.)`}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AcredBar({ acreditado, pendiente }: { acreditado: number; pendiente: number }) {
  const tot = Math.max(1, acreditado + pendiente);
  return (
    <div className="acred-bar" title={`Acreditado ${money(acreditado)} · Pendiente ${money(pendiente)}`}>
      <i className="acred-ok" style={{ width: `${(acreditado / tot) * 100}%` }} />
      <i className="acred-pend" style={{ width: `${(pendiente / tot) * 100}%` }} />
    </div>
  );
}

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

// ---- Matriz de decisión ----
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

// ---- Proyección: elegir SKU(s) y ver ganancia proyectada por venta ----
function Proyeccion({ res, cfg, prods }: { res: FinResultado; cfg: FinanzasConfig; prods: ProdRaw[] }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const finBySku = useMemo(() => new Map(res.productos.map((p) => [p.sku.toLowerCase(), p])), [res.productos]);
  const lista = prods.filter((p) => p.tipo === "P" || true).filter((p) => q ? `${p.nombre} ${p.sku}`.toLowerCase().includes(q.toLowerCase()) : true).slice(0, 200);

  function toggle(sku: string) {
    const n = new Set(sel); n.has(sku) ? n.delete(sku) : n.add(sku); setSel(n);
  }

  // Para cada SKU seleccionado, proyectamos UNA venta a precio de lista con los
  // costos del modelo (comisión real si existe, si no config; ML por defecto).
  const filas = [...sel].map((sku) => {
    const p = prods.find((x) => x.sku === sku)!;
    const fin = finBySku.get(sku.toLowerCase());
    const precio = Number(p.precio || 0);
    const costoUnit = fin?.precioCompraApp ? (fin.cogs / Math.max(1, fin.unidades)) : Number(p.costo || 0);
    const comPct = fin && fin.brutoMl > 0 ? fin.comision / Math.max(1, fin.bruto) : cfg.comision_ml;
    const sim = simularML({
      precio, unidades: 1, comisionPct: comPct,
      cuotasPct: 0, envioUnit: cfg.envio_full_default || cfg.costo_envio_default || 0,
      percepcionesPct: cfg.percepciones_pct || 0, costoUnit,
    });
    return { sku, nombre: p.nombre, sim };
  });
  const tot = filas.reduce((a, f) => ({
    bruto: a.bruto + f.sim.bruto, recibis: a.recibis + f.sim.recibis, ganancia: a.ganancia + f.sim.ganancia,
  }), { bruto: 0, recibis: 0, ganancia: 0 });

  return (
    <div className="fin-exec" style={{ alignItems: "start" }}>
      <div className="card card-pad">
        <div className="fin-box-t">Elegí SKU</div>
        <input className="input" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
        <div className="proy-list">
          {lista.map((p) => (
            <label key={p.sku} className={"proy-item " + (sel.has(p.sku) ? "on" : "")}>
              <input type="checkbox" checked={sel.has(p.sku)} onChange={() => toggle(p.sku)} />
              <span className="proy-nom">{p.nombre}</span>
              <span className="proy-sku">{p.sku}</span>
              <span className="proy-precio">{money(Number(p.precio || 0))}</span>
            </label>
          ))}
          {lista.length === 0 && <p className="muted">Sin resultados.</p>}
        </div>
      </div>

      <div className="card card-pad">
        <div className="fin-box-t">Proyección por venta (a precio de lista)</div>
        {filas.length === 0 ? <p className="muted">Seleccioná uno o más SKU para ver cuánto dejaría cada venta.</p> : (
          <>
            <div className="scroll-x"><table className="tbl fin-tbl">
              <thead><tr><th>Producto</th><th className="r">Precio</th><th className="r">Recibís</th><th className="r">Costo</th><th className="r">Ganancia</th><th className="r">Margen</th></tr></thead>
              <tbody>
                {filas.map((f) => (
                  <tr key={f.sku}>
                    <td><div className="fin-name">{f.nombre}</div><div className="fin-sku">{f.sku}</div></td>
                    <td className="r tnum">{money(f.sim.precio)}</td>
                    <td className="r tnum">{money(f.sim.recibis)}</td>
                    <td className="r tnum neg">{money(f.sim.costoTotal)}</td>
                    <td className={"r tnum " + (f.sim.ganancia >= 0 ? "ok" : "crit")}>{money(f.sim.ganancia)}</td>
                    <td className={"r tnum " + (f.sim.margen >= cfg.margen_min ? "ok" : "crit")}>{pct(f.sim.margen)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="fin-tot-row">
                <td>Total ({filas.length})</td><td className="r tnum">{money(tot.bruto)}</td><td className="r tnum">{money(tot.recibis)}</td>
                <td className="r"></td><td className={"r tnum " + (tot.ganancia >= 0 ? "ok" : "crit")}>{money(tot.ganancia)}</td>
                <td className="r tnum">{pct(tot.bruto > 0 ? tot.ganancia / tot.bruto : 0)}</td>
              </tr></tfoot>
            </table></div>
            <p className="faint" style={{ fontSize: ".76rem" }}>Estimación con comisión real por publicación cuando existe; envío/percepciones desde Ajustes. Para simular otro precio usá <b>＋ Proyección</b>.</p>
          </>
        )}
      </div>
    </div>
  );
}

// ---- Simulador de costos estilo Mercado Libre (modal) ----
function SimuladorModal({ cfg, prods, onClose }: { cfg: FinanzasConfig; prods: ProdRaw[]; onClose: () => void }) {
  const [skuSel, setSkuSel] = useState("");
  const [f, setF] = useState({
    precio: "", costo: "", comision: (cfg.comision_ml * 100).toFixed(1), cuotas: "0",
    envio: String(cfg.envio_full_default || 0), impuestos: ((cfg.percepciones_pct || 0) * 100).toFixed(1), unidades: "1",
  });
  function elegir(sku: string) {
    setSkuSel(sku);
    const p = prods.find((x) => x.sku === sku);
    if (p) setF((s) => ({ ...s, precio: String(p.precio || 0), costo: String(p.costo || 0) }));
  }
  const sim = simularML({
    precio: Number(f.precio) || 0, unidades: Number(f.unidades) || 1,
    comisionPct: (Number(f.comision) || 0) / 100, cuotasPct: (Number(f.cuotas) || 0) / 100,
    envioUnit: Number(f.envio) || 0, percepcionesPct: (Number(f.impuestos) || 0) / 100, costoUnit: Number(f.costo) || 0,
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: "min(620px,100%)" }}>
        <div className="modal-head"><div><span className="eyebrow">Simulador</span><h3 style={{ margin: "2px 0 0" }}>Costos de venta (estilo Mercado Libre)</h3></div><button className="btn ghost btn-sm" onClick={onClose}>✕</button></div>
        <div className="field"><label>Traer datos de un SKU <span className="muted">(opcional)</span></label>
          <select className="select" value={skuSel} onChange={(e) => elegir(e.target.value)}>
            <option value="">— manual —</option>
            {prods.slice(0, 400).map((p) => <option key={p.sku} value={p.sku}>{p.sku} · {p.nombre}</option>)}
          </select>
        </div>
        <div className="row2">
          <div className="field"><label>Precio de venta</label><input className="input" type="number" value={f.precio} onChange={set("precio")} placeholder="0" /></div>
          <div className="field"><label>Costo de compra (unit.)</label><input className="input" type="number" value={f.costo} onChange={set("costo")} placeholder="0" /></div>
        </div>
        <div className="row2">
          <div className="field"><label>Cargo por vender %</label><input className="input" type="number" step="0.1" value={f.comision} onChange={set("comision")} /></div>
          <div className="field"><label>Costo cuotas s/interés %</label><input className="input" type="number" step="0.1" value={f.cuotas} onChange={set("cuotas")} /></div>
        </div>
        <div className="row2">
          <div className="field"><label>Costo de envío (unit.)</label><input className="input" type="number" value={f.envio} onChange={set("envio")} /></div>
          <div className="field"><label>Impuestos / percepciones %</label><input className="input" type="number" step="0.1" value={f.impuestos} onChange={set("impuestos")} /></div>
        </div>
        <div className="field"><label>Unidades</label><input className="input" type="number" value={f.unidades} onChange={set("unidades")} /></div>

        <div className="card card-pad" style={{ marginTop: 4 }}>
          <PlRow k="Precio de venta" v={money(sim.bruto)} />
          <PlRow k="Cargo por vender" v={"-" + money(sim.cargoVender)} neg />
          {sim.costoCuotas > 0 && <PlRow k="Costo por cuotas" v={"-" + money(sim.costoCuotas)} neg />}
          <PlRow k="Costo de envío" v={"-" + money(sim.envio)} neg />
          {sim.impuestos > 0 && <PlRow k="Impuestos" v={"-" + money(sim.impuestos)} neg />}
          <div className="fin-pl-total"><span>Recibís</span><b className="ok">{money(sim.recibis)}</b></div>
          <PlRow k="Costo de la mercadería" v={"-" + money(sim.costoTotal)} neg />
          <div className="fin-pl-total"><span>Ganancia</span><b className={sim.ganancia >= 0 ? "ok" : "crit"}>{money(sim.ganancia)}</b></div>
          <div className="fin-pl-sub">Margen sobre venta {pct(sim.margen)}</div>
        </div>
        <p className="faint" style={{ fontSize: ".76rem" }}>Estimación local con los parámetros de arriba (Mercado Libre no expone un endpoint de simulador). El cargo por vender sale de la comisión real por publicación cuando la usás desde un SKU.</p>
      </div>
    </div>
  );
}
