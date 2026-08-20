// ============================================================================
// Motor de análisis financiero (cálculo en el cliente).
// Cruza ventas (cb_ventas) + productos (costo/precio) + compras (términos de
// pago) + devoluciones + configuración, y produce la rentabilidad y el ciclo de
// caja por producto, por proveedor y a nivel empresa, siguiendo el spec.
//
// Nota de datos: hoy cb_ventas guarda cantidad por SKU pero NO el importe, así
// que el ingreso bruto se ESTIMA con el precio de lista del producto (Contabilium
// PrecioFinal). El ciclo de caja necesita términos de pago de compra: se calcula
// donde exista compras_detalle; si no, queda "sin datos de compra".
// ============================================================================

export interface FinanzasConfig {
  tasa_anual: number; comision_ml: number; comision_tn: number;
  dias_cobro_ml: number; dias_cobro_tn: number; costo_envio_default: number; margen_min: number;
}
export interface CompraDetalle {
  id: string; sku: string | null; proveedor: string | null;
  precio_unitario: number; cantidad: number; fecha_compra: string;
  condicion_pago_dias: number; tasa_financiacion: number;
}
export interface VentaRaw { fecha: string; origen: string | null; items: { sku: string; cantidad: number }[]; }
export interface DevRaw { sku: string | null; cantidad: number; valor_perdida: number | null; estado: string; }
export interface ProdRaw { sku: string; nombre: string; costo: number | null; precio: number | null; tipo: string; }

export interface FinProducto {
  sku: string; nombre: string; proveedor: string;
  unidades: number; bruto: number; comision: number; cogs: number;
  envio: number; devoluciones: number; financiacion: number;
  neto: number; margen: number; roi: number;
  ciclo: number | null; capital: number; autofinancia: boolean | null;
  sinPrecio: boolean; sinCompra: boolean;
  cuadrante: "A" | "B" | "C" | "D" | null;
}
export interface FinProveedor {
  proveedor: string; productos: number; unidades: number;
  bruto: number; neto: number; cogs: number; capital: number;
  margen: number; ciclo: number | null; autofinancia: boolean | null;
  tasaDevolucion: number; items: FinProducto[];
}
export interface FinEmpresa {
  bruto: number; comision: number; cogs: number; logistica: number;
  financiacion: number; neto: number; margen: number; roi: number;
  capital: number; ciclo: number | null; autofinancia: boolean;
  excedente: number; tasaDevolucion: number;
  unidades: number; skus: number; sinPrecio: number; sinCompra: number;
}
export interface FinResultado { productos: FinProducto[]; proveedores: FinProveedor[]; empresa: FinEmpresa; }

const low = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();
function canalDe(origen: string | null): "ml" | "tn" {
  const o = low(origen);
  if (o.includes("nube") || o.includes("tienda")) return "tn";
  return "ml";
}

export function calcularFinanzas(
  ventas: VentaRaw[], productos: ProdRaw[], compras: CompraDetalle[], devoluciones: DevRaw[],
  cfg: FinanzasConfig, dias = 60,
): FinResultado {
  const desde = Date.now() - dias * 86400_000;
  const prod = new Map<string, ProdRaw>();
  for (const p of productos) prod.set(low(p.sku), p);

  // Compras por SKU: monto, días de pago ponderados, tasa, proveedor.
  const comprasSku = new Map<string, { monto: number; diasPond: number; tasaPond: number; proveedor: string }>();
  for (const c of compras) {
    const k = low(c.sku); if (!k) continue;
    const monto = Number(c.precio_unitario || 0) * Number(c.cantidad || 0);
    const cur = comprasSku.get(k) ?? { monto: 0, diasPond: 0, tasaPond: 0, proveedor: "" };
    cur.monto += monto;
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

  // Acumular ventas por SKU (dentro del período).
  type Acc = { unidades: number; bruto: number; comision: number; cobroPond: number };
  const acc = new Map<string, Acc>();
  for (const v of ventas) {
    if (v.fecha && new Date(v.fecha).getTime() < desde) continue;
    const canal = canalDe(v.origen);
    const comRate = canal === "tn" ? cfg.comision_tn : cfg.comision_ml;
    const diasCobro = canal === "tn" ? cfg.dias_cobro_tn : cfg.dias_cobro_ml;
    for (const it of v.items ?? []) {
      const k = low(it.sku); if (!k) continue;
      const p = prod.get(k);
      const precio = Number(p?.precio || 0);
      const cant = Number(it.cantidad || 0);
      const bruto = precio * cant;
      const a = acc.get(k) ?? { unidades: 0, bruto: 0, comision: 0, cobroPond: 0 };
      a.unidades += cant;
      a.bruto += bruto;
      a.comision += bruto * comRate;
      a.cobroPond += diasCobro * bruto;
      acc.set(k, a);
    }
  }

  const productosFin: FinProducto[] = [];
  for (const [k, a] of acc) {
    const p = prod.get(k);
    const costo = Number(p?.costo || 0);
    const cogs = a.unidades * costo;
    const envio = a.unidades * cfg.costo_envio_default;
    const dev = devSku.get(k);
    const devCost = dev?.perdida ?? 0;
    const compra = comprasSku.get(k);

    const diasCobro = a.bruto > 0 ? a.cobroPond / a.bruto : (cfg.dias_cobro_ml);
    const diasPago = compra && compra.monto > 0 ? compra.diasPond / compra.monto : null;
    const ciclo = diasPago != null ? Math.round(diasCobro - diasPago) : null;
    const base = compra && compra.monto > 0 ? compra.monto : cogs;
    const tasa = compra && compra.monto > 0 && compra.tasaPond > 0 ? compra.tasaPond / compra.monto : cfg.tasa_anual;
    const capital = ciclo != null && ciclo > 0 ? base * (ciclo / 30) : 0;
    const financiacion = capital > 0 ? (capital * tasa * ciclo!) / 365 : 0;

    const neto = a.bruto - a.comision - cogs - envio - devCost - financiacion;
    const margen = a.bruto > 0 ? neto / a.bruto : 0;
    const roi = cogs > 0 ? neto / cogs : 0;
    const autofinancia = ciclo != null ? ciclo < 0 : null;

    let cuadrante: FinProducto["cuadrante"] = null;
    if (a.bruto > 0 && ciclo != null) {
      const alto = margen >= cfg.margen_min;
      const auto = ciclo < 0;
      cuadrante = alto ? (auto ? "A" : "B") : (auto ? "C" : "D");
    }

    productosFin.push({
      sku: p?.sku ?? k, nombre: p?.nombre ?? k, proveedor: compra?.proveedor || "Sin proveedor asignado",
      unidades: a.unidades, bruto: a.bruto, comision: a.comision, cogs,
      envio, devoluciones: devCost, financiacion,
      neto, margen, roi, ciclo, capital, autofinancia,
      sinPrecio: a.bruto === 0, sinCompra: !compra,
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
    const unidades = items.reduce((s, i) => s + i.unidades, 0);
    const cicloItems = items.filter((i) => i.ciclo != null);
    const cicloPond = cicloItems.reduce((s, i) => s + i.ciclo! * i.bruto, 0);
    const cicloBase = cicloItems.reduce((s, i) => s + i.bruto, 0);
    const ciclo = cicloBase > 0 ? Math.round(cicloPond / cicloBase) : null;
    proveedores.push({
      proveedor, productos: items.length, unidades, bruto, neto, cogs, capital,
      margen: bruto > 0 ? neto / bruto : 0, ciclo, autofinancia: ciclo != null ? ciclo < 0 : null,
      tasaDevolucion: 0, items,
    });
  }
  proveedores.sort((a, b) => b.bruto - a.bruto);

  // Empresa.
  const bruto = productosFin.reduce((s, i) => s + i.bruto, 0);
  const comision = productosFin.reduce((s, i) => s + i.comision, 0);
  const cogs = productosFin.reduce((s, i) => s + i.cogs, 0);
  const logistica = productosFin.reduce((s, i) => s + i.envio + i.devoluciones, 0);
  const financiacion = productosFin.reduce((s, i) => s + i.financiacion, 0);
  const neto = productosFin.reduce((s, i) => s + i.neto, 0);
  const capital = productosFin.reduce((s, i) => s + i.capital, 0);
  const cicloItems = productosFin.filter((i) => i.ciclo != null);
  const cicloPond = cicloItems.reduce((s, i) => s + i.ciclo! * i.bruto, 0);
  const cicloBase = cicloItems.reduce((s, i) => s + i.bruto, 0);
  const ciclo = cicloBase > 0 ? Math.round(cicloPond / cicloBase) : null;
  const unidadesTot = productosFin.reduce((s, i) => s + i.unidades, 0);
  const unidadesDev = devoluciones.reduce((s, d) => s + Number(d.cantidad || 0), 0);

  const empresa: FinEmpresa = {
    bruto, comision, cogs, logistica, financiacion, neto,
    margen: bruto > 0 ? neto / bruto : 0, roi: cogs > 0 ? neto / cogs : 0,
    capital, ciclo, autofinancia: ciclo != null ? ciclo < 0 : false,
    excedente: neto > 0 && (ciclo == null || ciclo < 0) ? neto : 0,
    tasaDevolucion: unidadesTot > 0 ? unidadesDev / unidadesTot : 0,
    unidades: unidadesTot, skus: productosFin.length,
    sinPrecio: productosFin.filter((i) => i.sinPrecio).length,
    sinCompra: productosFin.filter((i) => i.sinCompra).length,
  };

  return { productos: productosFin, proveedores, empresa };
}
