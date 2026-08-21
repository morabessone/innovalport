// ============================================================================
// Motor de análisis financiero (cálculo en el cliente).
// Cruza ventas (cb_ventas) + productos (costo/precio) + compras (términos de
// pago) + devoluciones + configuración, y produce la rentabilidad y el ciclo de
// caja por producto, por proveedor y a nivel empresa, siguiendo el spec + el
// feedback de Martín.
//
// Precisión por canal (feedback):
//  · Mercado Libre = EXACTO donde hay dato de API: comisión real por publicación,
//    + envío Full (config/def), + envío Flex manual por SKU, + percepciones %,
//    + financiación MP %, + devoluciones reales.
//  · Tienda Nube = APROXIMADO: un único bucket de gasto (config tn_gasto_pct,
//    def 15%) sobre la venta bruta. Se marca como aproximado en la UI.
//
// Autoridad del precio de compra (feedback P2): el COGS usa el precio de compra
// cargado en la app (compras_detalle o producto_finanzas) por encima del costo
// de Contabilium. El costo de Contabilium queda de respaldo.
// ============================================================================

export interface FinanzasConfig {
  tasa_anual: number; comision_ml: number; comision_tn: number;
  dias_cobro_ml: number; dias_cobro_tn: number; costo_envio_default: number; margen_min: number;
  // Buckets de costo agregados por el feedback (con defaults en el caller).
  percepciones_pct: number; financiacion_mp_pct: number; tn_gasto_pct: number; envio_full_default: number;
  dias_acreditacion_ml: number;
}
export interface CompraDetalle {
  id: string; sku: string | null; proveedor: string | null;
  precio_unitario: number; cantidad: number; fecha_compra: string;
  condicion_pago_dias: number; tasa_financiacion: number;
}
export interface VentaRaw { fecha: string; origen: string | null; items: { sku: string; cantidad: number; monto?: number }[]; }
export interface DevRaw { sku: string | null; cantidad: number; valor_perdida: number | null; estado: string; }
export interface ProdRaw { id?: string; sku: string; nombre: string; costo: number | null; precio: number | null; tipo: string; }
export interface ProductoFinRaw {
  producto_id: string; proveedor: string | null; precio_compra: number | null;
  condicion_pago_dias: number; tasa_financiacion: number;
  envio_flex?: number | null; condicion_pago_label?: string | null; canal_principal?: string | null;
}
// Datos extra para un cálculo más preciso (comisión real de ML por SKU y
// parámetros financieros por producto editados a mano). Además, datos reales
// traídos de la API de Mercado Libre por SKU:
//   feeRealSku   -> comisión real por venta (order_items[].sale_fee),
//   envioRealSku -> logística real al vendedor (shipments/{id}/costs),
//   adsSku       -> inversión de Mercado Ads (Product Ads) del período.
export interface FinExtra {
  comisionSku?: Map<string, number>;
  prodFinSku?: Map<string, ProductoFinRaw>;
  feeRealSku?: Map<string, { fee: number; monto: number }>;
  envioRealSku?: Map<string, { envio: number; monto: number }>;
  adsSku?: Map<string, number>;
  flexRealSku?: Map<string, number>;   // costo real de envío Flex (Flexit) por SKU en el período
}

export interface FinProducto {
  sku: string; nombre: string; proveedor: string;
  unidades: number; bruto: number;
  // Desglose de costos (feedback P4).
  comision: number; cogs: number; envioFull: number; envioFlex: number;
  percepciones: number; financiacionMp: number; gastoTn: number; ads: number;
  devoluciones: number; financiacion: number;
  comisionReal: boolean; envioReal: boolean; flexReal: boolean;
  neto: number; margen: number; roi: number;
  ciclo: number | null; capital: number; capitalNeto: number; autofinancia: boolean | null;
  // Split de canal para etiquetar exacto (ML) vs aproximado (TN).
  brutoMl: number; brutoTn: number; canal: "ML" | "TN" | "Ambos" | "—";
  tasaDevolucion: number;
  sinPrecio: boolean; sinCompra: boolean; precioCompraApp: boolean;
  cuadrante: "A" | "B" | "C" | "D" | null;
}
export interface FinProveedor {
  proveedor: string; productos: number; unidades: number;
  bruto: number; neto: number; cogs: number;
  capital: number; capitalDisponible: number; capitalNeto: number;
  margen: number; ciclo: number | null; autofinancia: boolean | null;
  tasaDevolucion: number; items: FinProducto[];
}
export interface FinEmpresa {
  bruto: number; comision: number; cogs: number; logistica: number;
  percepciones: number; financiacionMp: number; gastoTn: number; ads: number;
  financiacion: number; neto: number; margen: number; roi: number;
  capital: number; capitalDisponible: number; capitalNeto: number;
  ciclo: number | null; autofinancia: boolean;
  excedente: number; tasaDevolucion: number;
  brutoMl: number; brutoTn: number;
  unidades: number; skus: number; sinPrecio: number; sinCompra: number;
}
export interface FinResultado { productos: FinProducto[]; proveedores: FinProveedor[]; empresa: FinEmpresa; }

// Órdenes de ML (tabla ml_ordenes) para acreditación y datos reales por SKU.
export interface MlOrdenRaw {
  sku: string | null; fecha: string; monto: number; sale_fee: number;
  envio_costo: number; acreditado: boolean; fecha_acreditacion: string | null;
  pago_estado?: string | null;
}
export interface Acreditacion {
  acreditado: number; pendiente: number; total: number;
  ordenes: number; ordenesAcred: number; estimado: boolean;
  proximaLiberacion: string | null; montoProxima7d: number;
  porSku: Map<string, { acreditado: number; pendiente: number }>;
}
// Diferencia el capital YA disponible (acreditado por Mercado Pago) del que está
// pendiente de acreditarse — lo que Martín llama "capital disponible".
// Si la orden tiene dato REAL de Mercado Pago (acreditado / fecha_acreditacion)
// se usa; si no, se ESTIMA por antigüedad (>= lagDias desde la venta). Devuelve
// `estimado: true` cuando alguna orden se resolvió por estimación.
export function resumenAcreditacion(ordenes: MlOrdenRaw[], dias: number, lagDias = 7): Acreditacion {
  const desde = Date.now() - dias * 86400_000;
  const porSku = new Map<string, { acreditado: number; pendiente: number }>();
  let acreditado = 0, pendiente = 0, ordenesAcred = 0, n = 0, estimadas = 0;
  let proxima: number | null = null, montoProxima7d = 0;
  const en7d = Date.now() + 7 * 86400_000;
  for (const o of ordenes) {
    if (o.fecha && new Date(o.fecha).getTime() < desde) continue;
    const est = String(o.pago_estado ?? "").toLowerCase();
    if (est && est !== "approved") continue;   // solo pagos aprobados cuentan como capital
    n++;
    const monto = Number(o.monto || 0);
    const k = String(o.sku ?? "").trim().toLowerCase();
    const cur = porSku.get(k) ?? { acreditado: 0, pendiente: 0 };
    let acred = o.acreditado;
    if (!o.fecha_acreditacion && !o.acreditado) {           // sin dato real → estimar por antigüedad
      const ageDias = o.fecha ? (Date.now() - new Date(o.fecha).getTime()) / 86400_000 : 0;
      acred = ageDias >= lagDias;
      estimadas++;
    }
    if (acred) { acreditado += monto; cur.acreditado += monto; ordenesAcred++; }
    else {
      pendiente += monto; cur.pendiente += monto;
      // Próxima liberación real (money_release_date futuro).
      if (o.fecha_acreditacion) {
        const t = new Date(o.fecha_acreditacion).getTime();
        if (t > Date.now()) { if (proxima == null || t < proxima) proxima = t; if (t <= en7d) montoProxima7d += monto; }
      }
    }
    if (k) porSku.set(k, cur);
  }
  return {
    acreditado, pendiente, total: acreditado + pendiente, ordenes: n, ordenesAcred,
    estimado: estimadas > 0, proximaLiberacion: proxima != null ? new Date(proxima).toISOString() : null,
    montoProxima7d, porSku,
  };
}
// Construye los mapas de datos reales de ML por SKU a partir de ml_ordenes.
export function mapsDeOrdenes(ordenes: MlOrdenRaw[], dias: number): {
  feeRealSku: Map<string, { fee: number; monto: number }>;
  envioRealSku: Map<string, { envio: number; monto: number }>;
} {
  const desde = Date.now() - dias * 86400_000;
  const feeRealSku = new Map<string, { fee: number; monto: number }>();
  const envioRealSku = new Map<string, { envio: number; monto: number }>();
  for (const o of ordenes) {
    if (o.fecha && new Date(o.fecha).getTime() < desde) continue;
    const k = String(o.sku ?? "").trim().toLowerCase();
    if (!k) continue;
    const monto = Number(o.monto || 0);
    const f = feeRealSku.get(k) ?? { fee: 0, monto: 0 }; f.fee += Number(o.sale_fee || 0); f.monto += monto; feeRealSku.set(k, f);
    const e = envioRealSku.get(k) ?? { envio: 0, monto: 0 }; e.envio += Number(o.envio_costo || 0); e.monto += monto; envioRealSku.set(k, e);
  }
  return { feeRealSku, envioRealSku };
}

const low = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();
function canalDe(origen: string | null): "ml" | "tn" {
  const o = low(origen);
  if (o.includes("nube") || o.includes("tienda")) return "tn";
  return "ml";
}

export function calcularFinanzas(
  ventas: VentaRaw[], productos: ProdRaw[], compras: CompraDetalle[], devoluciones: DevRaw[],
  cfg: FinanzasConfig, dias = 60, extra: FinExtra = {},
): FinResultado {
  const desde = Date.now() - dias * 86400_000;
  const comisionSku = extra.comisionSku ?? new Map<string, number>();
  const prodFinSku = extra.prodFinSku ?? new Map<string, ProductoFinRaw>();
  const feeRealSku = extra.feeRealSku ?? new Map<string, { fee: number; monto: number }>();
  const envioRealSku = extra.envioRealSku ?? new Map<string, { envio: number; monto: number }>();
  const adsSku = extra.adsSku ?? new Map<string, number>();
  const flexRealSku = extra.flexRealSku ?? new Map<string, number>();
  const prod = new Map<string, ProdRaw>();
  for (const p of productos) prod.set(low(p.sku), p);

  // Compras por SKU: monto, días de pago ponderados, tasa, proveedor, precio unit.
  const comprasSku = new Map<string, { monto: number; unidades: number; diasPond: number; tasaPond: number; proveedor: string }>();
  for (const c of compras) {
    const k = low(c.sku); if (!k) continue;
    const monto = Number(c.precio_unitario || 0) * Number(c.cantidad || 0);
    const cur = comprasSku.get(k) ?? { monto: 0, unidades: 0, diasPond: 0, tasaPond: 0, proveedor: "" };
    cur.monto += monto;
    cur.unidades += Number(c.cantidad || 0);
    cur.diasPond += Number(c.condicion_pago_dias || 0) * monto;
    cur.tasaPond += Number(c.tasa_financiacion || 0) * monto;
    if (c.proveedor) cur.proveedor = c.proveedor;
    comprasSku.set(k, cur);
  }

  // Devoluciones por SKU.
  const devSku = new Map<string, { unidades: number; perdida: number }>();
  for (const d of devoluciones) {
    const k = low(d.sku); if (!k) continue;
    const cur = devSku.get(k) ?? { unidades: 0, perdida: 0 };
    cur.unidades += Number(d.cantidad || 0);
    cur.perdida += Number(d.valor_perdida || 0);
    devSku.set(k, cur);
  }

  // Acumular ventas por SKU (dentro del período), separando canal.
  type Acc = {
    unidades: number; bruto: number; brutoMl: number; brutoTn: number;
    comision: number; cobroPond: number;
  };
  const acc = new Map<string, Acc>();
  for (const v of ventas) {
    if (v.fecha && new Date(v.fecha).getTime() < desde) continue;
    const canal = canalDe(v.origen);
    const diasCobro = canal === "tn" ? cfg.dias_cobro_tn : cfg.dias_cobro_ml;
    for (const it of v.items ?? []) {
      const k = low(it.sku); if (!k) continue;
      const p = prod.get(k);
      const cant = Number(it.cantidad || 0);
      // Importe REAL de Contabilium si está; si no, se estima con el precio de lista.
      const bruto = Number(it.monto || 0) > 0 ? Number(it.monto) : Number(p?.precio || 0) * cant;
      // Comisión REAL de ML por SKU (listing_prices) si está; si no, el promedio.
      const comRate = canal === "tn" ? cfg.comision_tn : (comisionSku.get(k) ?? cfg.comision_ml);
      const a = acc.get(k) ?? { unidades: 0, bruto: 0, brutoMl: 0, brutoTn: 0, comision: 0, cobroPond: 0 };
      a.unidades += cant;
      a.bruto += bruto;
      if (canal === "tn") a.brutoTn += bruto; else a.brutoMl += bruto;
      a.comision += bruto * comRate;
      a.cobroPond += diasCobro * bruto;
      acc.set(k, a);
    }
  }

  const productosFin: FinProducto[] = [];
  for (const [k, a] of acc) {
    const p = prod.get(k);
    const compra = comprasSku.get(k);
    const pf = prodFinSku.get(k);   // parámetros por producto (editados a mano)

    // --- Autoridad del precio de compra (feedback P2) ---
    // Preferimos el precio de compra cargado en la app: compras_detalle (real de
    // la última compra) → producto_finanzas → costo de Contabilium (respaldo).
    let costoUnit = Number(p?.costo || 0);
    let precioCompraApp = false;
    if (compra && compra.monto > 0 && compra.unidades > 0) { costoUnit = compra.monto / compra.unidades; precioCompraApp = true; }
    else if (pf?.precio_compra != null && Number(pf.precio_compra) > 0) { costoUnit = Number(pf.precio_compra); precioCompraApp = true; }
    const cogs = a.unidades * costoUnit;

    // --- Desglose de costos por canal (feedback P4) ---
    // ML: envío Full (real de la API si existe, si no config) + envío Flex manual
    // por SKU + percepciones % + financiación MP % + inversión de ads.
    const unidadesMl = a.bruto > 0 ? a.unidades * (a.brutoMl / a.bruto) : a.unidades;
    const envReal = envioRealSku.get(k);
    const envioReal = !!(envReal && envReal.monto > 0);
    const envioFull = envioReal
      ? a.brutoMl * (envReal!.envio / envReal!.monto)          // logística real de ML
      : unidadesMl * (cfg.envio_full_default || cfg.costo_envio_default || 0);
    // Envío Flex: costo REAL de Flexit (entregas) si está; si no, el cargado a
    // mano por SKU. (El envío Full real de ML ya cubre las ventas Full.)
    const flexReal = flexRealSku.has(k);
    const envioFlex = flexReal ? Number(flexRealSku.get(k)) : (envioReal ? 0 : unidadesMl * Number(pf?.envio_flex || 0));
    const percepciones = a.brutoMl * (cfg.percepciones_pct || 0);
    const financiacionMp = a.brutoMl * (cfg.financiacion_mp_pct || 0);
    const ads = adsSku.get(k) ?? 0;                            // inversión Product Ads del período
    // TN: bucket único APROXIMADO. Reemplaza comisión/envío/percepciones de TN.
    const gastoTn = a.brutoTn * (cfg.tn_gasto_pct || 0);
    // Comisión de ML: real (order_items[].sale_fee) si la tenemos; si no, la
    // acumulada por listing_prices. La comisión acumulada incluye TN, la sacamos.
    const feeReal = feeRealSku.get(k);
    const comisionReal = !!(feeReal && feeReal.monto > 0);
    const comisionMl = comisionReal
      ? a.brutoMl * (feeReal!.fee / feeReal!.monto)
      : a.comision - a.brutoTn * cfg.comision_tn;

    const dev = devSku.get(k);
    const devCost = dev?.perdida ?? 0;

    const diasCobro = a.bruto > 0 ? a.cobroPond / a.bruto : cfg.dias_cobro_ml;
    // Días de pago al proveedor: de las compras reales, o de los parámetros del
    // producto si se cargaron a mano; si no hay ninguno, el ciclo queda sin dato.
    let diasPago: number | null = null;
    let base = cogs;
    let tasa = cfg.tasa_anual;
    if (compra && compra.monto > 0) {
      diasPago = compra.diasPond / compra.monto;
      base = compra.monto;
      tasa = compra.tasaPond > 0 ? compra.tasaPond / compra.monto : cfg.tasa_anual;
    } else if (pf) {
      diasPago = Number(pf.condicion_pago_dias || 0);
      base = pf.precio_compra ? Number(pf.precio_compra) * a.unidades : cogs;
      tasa = pf.tasa_financiacion ? Number(pf.tasa_financiacion) / 100 : cfg.tasa_anual;
    }
    const ciclo = diasPago != null ? Math.round(diasCobro - diasPago) : null;
    // Capital: positivo = inmoviliza (pagás antes de cobrar). Negativo = se
    // autofinancia (cobrás antes de pagar) → libera caja.
    const capitalNeto = ciclo != null ? base * (ciclo / 30) : 0;
    const capital = capitalNeto > 0 ? capitalNeto : 0;
    const financiacion = capital > 0 ? (capital * tasa * ciclo!) / 365 : 0;

    // Comisión de marketplace = SOLO Mercado Libre. Tienda Nube no suma comisión
    // aparte: todos sus gastos (comisión + envío + percepciones) van al bucket
    // único aproximado `gastoTn`, para no duplicar (feedback P4).
    const comision = comisionMl;
    const neto = a.bruto - comisionMl - cogs - envioFull - envioFlex - percepciones - financiacionMp - ads - gastoTn - devCost - financiacion;
    const margen = a.bruto > 0 ? neto / a.bruto : 0;
    const roi = cogs > 0 ? neto / cogs : 0;
    const autofinancia = ciclo != null ? ciclo < 0 : null;
    const tasaDevolucion = a.unidades > 0 ? (dev?.unidades ?? 0) / a.unidades : 0;

    let cuadrante: FinProducto["cuadrante"] = null;
    if (a.bruto > 0 && ciclo != null) {
      const alto = margen >= cfg.margen_min;
      const auto = ciclo < 0;
      cuadrante = alto ? (auto ? "A" : "B") : (auto ? "C" : "D");
    }

    const canal: FinProducto["canal"] = a.brutoMl > 0 && a.brutoTn > 0 ? "Ambos"
      : a.brutoMl > 0 ? "ML" : a.brutoTn > 0 ? "TN" : "—";

    productosFin.push({
      sku: p?.sku ?? k, nombre: p?.nombre ?? k,
      proveedor: compra?.proveedor || pf?.proveedor || "Sin proveedor asignado",
      unidades: a.unidades, bruto: a.bruto,
      comision, cogs, envioFull, envioFlex, percepciones, financiacionMp, gastoTn, ads,
      devoluciones: devCost, financiacion, comisionReal, envioReal, flexReal,
      neto, margen, roi, ciclo, capital, capitalNeto, autofinancia,
      brutoMl: a.brutoMl, brutoTn: a.brutoTn, canal, tasaDevolucion,
      sinPrecio: a.bruto === 0, sinCompra: !compra && !pf, precioCompraApp,
      cuadrante,
    });
  }
  productosFin.sort((x, y) => y.bruto - x.bruto);

  // Agregación por proveedor.
  const provMap = new Map<string, FinProducto[]>();
  for (const p of productosFin) {
    const arr = provMap.get(p.proveedor) ?? [];
    arr.push(p); provMap.set(p.proveedor, arr);
  }
  const proveedores: FinProveedor[] = [];
  for (const [proveedor, items] of provMap) {
    const bruto = items.reduce((s, i) => s + i.bruto, 0);
    const neto = items.reduce((s, i) => s + i.neto, 0);
    const cogs = items.reduce((s, i) => s + i.cogs, 0);
    const capital = items.reduce((s, i) => s + i.capital, 0);
    const capitalDisponible = items.reduce((s, i) => s + (i.capitalNeto < 0 ? -i.capitalNeto : 0), 0);
    const unidades = items.reduce((s, i) => s + i.unidades, 0);
    const devU = items.reduce((s, i) => s + i.tasaDevolucion * i.unidades, 0);
    const cicloItems = items.filter((i) => i.ciclo != null);
    const cicloPond = cicloItems.reduce((s, i) => s + i.ciclo! * i.bruto, 0);
    const cicloBase = cicloItems.reduce((s, i) => s + i.bruto, 0);
    const ciclo = cicloBase > 0 ? Math.round(cicloPond / cicloBase) : null;
    proveedores.push({
      proveedor, productos: items.length, unidades, bruto, neto, cogs,
      capital, capitalDisponible, capitalNeto: capital - capitalDisponible,
      margen: bruto > 0 ? neto / bruto : 0, ciclo, autofinancia: ciclo != null ? ciclo < 0 : null,
      tasaDevolucion: unidades > 0 ? devU / unidades : 0, items,
    });
  }
  proveedores.sort((a, b) => b.bruto - a.bruto);

  // Empresa.
  const sum = (f: (i: FinProducto) => number) => productosFin.reduce((s, i) => s + f(i), 0);
  const bruto = sum((i) => i.bruto);
  const comision = sum((i) => i.comision);
  const cogs = sum((i) => i.cogs);
  const logistica = sum((i) => i.envioFull + i.envioFlex + i.devoluciones);
  const percepciones = sum((i) => i.percepciones);
  const financiacionMp = sum((i) => i.financiacionMp);
  const gastoTn = sum((i) => i.gastoTn);
  const ads = sum((i) => i.ads);
  const financiacion = sum((i) => i.financiacion);
  const neto = sum((i) => i.neto);
  const capital = sum((i) => i.capital);
  const capitalDisponible = sum((i) => (i.capitalNeto < 0 ? -i.capitalNeto : 0));
  const cicloItems = productosFin.filter((i) => i.ciclo != null);
  const cicloPond = cicloItems.reduce((s, i) => s + i.ciclo! * i.bruto, 0);
  const cicloBase = cicloItems.reduce((s, i) => s + i.bruto, 0);
  const ciclo = cicloBase > 0 ? Math.round(cicloPond / cicloBase) : null;
  const unidadesTot = sum((i) => i.unidades);
  const unidadesDev = devoluciones.reduce((s, d) => s + Number(d.cantidad || 0), 0);

  const empresa: FinEmpresa = {
    bruto, comision, cogs, logistica, percepciones, financiacionMp, gastoTn, ads, financiacion, neto,
    margen: bruto > 0 ? neto / bruto : 0, roi: cogs > 0 ? neto / cogs : 0,
    capital, capitalDisponible, capitalNeto: capital - capitalDisponible,
    ciclo, autofinancia: ciclo != null ? ciclo < 0 : false,
    excedente: neto > 0 && (ciclo == null || ciclo < 0) ? neto : 0,
    tasaDevolucion: unidadesTot > 0 ? unidadesDev / unidadesTot : 0,
    brutoMl: sum((i) => i.brutoMl), brutoTn: sum((i) => i.brutoTn),
    unidades: unidadesTot, skus: productosFin.length,
    sinPrecio: productosFin.filter((i) => i.sinPrecio).length,
    sinCompra: productosFin.filter((i) => i.sinCompra).length,
  };

  return { productos: productosFin, proveedores, empresa };
}

// ============================================================================
// Simulador de costos estilo Mercado Libre (para la subtab Proyección).
// Replica la lógica del simulador de ML: sobre un precio de venta calcula el
// cargo por vender (comisión), el costo de las cuotas sin interés (si el
// vendedor lo absorbe), el costo de envío y los impuestos/percepciones, y
// devuelve lo que "Recibís". No usa API — es un modelo con los parámetros de
// la config, marcado como estimación.
// ============================================================================
export interface SimInput {
  precio: number; unidades: number;
  comisionPct: number;        // cargo por vender (fracción)
  cuotasPct: number;          // costo de cuotas sin interés absorbido (fracción)
  envioUnit: number;          // costo de envío por unidad
  percepcionesPct: number;    // impuestos/percepciones (fracción)
  costoUnit: number;          // costo de compra por unidad (para ganancia)
}
export interface SimResultado {
  precio: number; unidades: number; bruto: number;
  cargoVender: number; costoCuotas: number; envio: number; impuestos: number;
  recibis: number; costoTotal: number; ganancia: number; margen: number;
}
export function simularML(inp: SimInput): SimResultado {
  const bruto = inp.precio * inp.unidades;
  const cargoVender = bruto * Math.max(0, inp.comisionPct);
  const costoCuotas = bruto * Math.max(0, inp.cuotasPct);
  const envio = inp.envioUnit * inp.unidades;
  const impuestos = bruto * Math.max(0, inp.percepcionesPct);
  const recibis = bruto - cargoVender - costoCuotas - envio - impuestos;
  const costoTotal = inp.costoUnit * inp.unidades;
  const ganancia = recibis - costoTotal;
  return {
    precio: inp.precio, unidades: inp.unidades, bruto,
    cargoVender, costoCuotas, envio, impuestos,
    recibis, costoTotal, ganancia, margen: bruto > 0 ? ganancia / bruto : 0,
  };
}
