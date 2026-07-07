// Datos y lógica de MODO DEMO: el panel funciona sin backend, con datos de
// ejemplo en memoria. Las acciones mutan este store para que se vea el efecto.
import type {
  Deposito, StockConsolidado, Remito, Devolucion, IngresoItem,
} from "./types.ts";

export const demoDepositos: Deposito[] = [
  { id: "d-gen", codigo: "GEN", nombre: "Genpol (Don Torcuato)", es_full: false },
  { id: "d-flx", codigo: "FLX", nombre: "Flexit (envíos Flex)", es_full: false },
  { id: "d-full", codigo: "FULL", nombre: "Full (Mercado Libre)", es_full: true },
  { id: "d-ofi", codigo: "OFI", nombre: "Oficina", es_full: false },
];

interface DemoProd {
  producto_id: string; sku: string; nombre: string; stock_minimo: number;
  por: Record<string, number>;
}

const prods: DemoProd[] = [
  { producto_id: "p1", sku: "INODORO-INTEL-PORT", nombre: "Inodoro inteligente", stock_minimo: 5, por: { GEN: 40, FULL: 12 } },
  { producto_id: "p2", sku: "BACHA-INTEL-PORT", nombre: "Bacha inteligente", stock_minimo: 5, por: { GEN: 88, FLX: 20 } },
  { producto_id: "p3", sku: "DUCHAPROPIO-PORT", nombre: "Duchador inteligente", stock_minimo: 8, por: { FLX: 3 } },
  { producto_id: "p4", sku: "CAM-WIFI-PORT", nombre: "Cámara de seguridad wifi", stock_minimo: 10, por: { FULL: 0, GEN: 6 } },
  { producto_id: "p5", sku: "TIMBRE-WIFI-PORT", nombre: "Timbre wifi con cámara", stock_minimo: 6, por: { GEN: 24, FULL: 9 } },
  { producto_id: "p6", sku: "ROBOT-COCINA-PORT", nombre: "Robot de cocina", stock_minimo: 3, por: { GEN: 15 } },
];

const remitos: Remito[] = [
  mkRemito("movimiento", "d-gen", "d-flx", "Reposición Flex"),
];
const devoluciones: Devolucion[] = [
  { id: "dev1", sku: "CAM-WIFI-PORT", producto_id: "p4", cantidad: 1, canal: "ML",
    venta_ref: "2000004512345", motivo: "No configura wifi", estado: "en_oficina",
    valor_perdida: null, created_at: hoursAgo(20) },
];
function mkRemito(tipo: string, origen: string | null, destino: string | null, nota: string): Remito {
  return {
    id: "r" + Math.random().toString(36).slice(2, 8),
    numero_int: ++mkRemito.seq, tipo, origen_deposito_id: origen,
    destino_deposito_id: destino, estado: "emitido", nota, created_at: new Date().toISOString(),
  };
}
mkRemito.seq = 1041;

function hoursAgo(h: number) { return new Date(Date.now() - h * 3600_000).toISOString(); }

function estadoDe(total: number, min: number): StockConsolidado["estado"] {
  if (total <= 0) return "sin_stock";
  if (total <= min) return "reponer";
  return "ok";
}

export const demo = {
  depositos: () => demoDepositos,

  stock(): StockConsolidado[] {
    return prods.map((p) => {
      const total = Object.values(p.por).reduce((a, b) => a + b, 0);
      return {
        producto_id: p.producto_id, sku: p.sku, nombre: p.nombre,
        stock_minimo: p.stock_minimo, por_deposito: { ...p.por }, total,
        estado: estadoDe(total, p.stock_minimo),
      };
    });
  },

  remitos: () => [...remitos].sort((a, b) => b.numero_int - a.numero_int),
  devoluciones: () => [...devoluciones].sort((a, b) => b.created_at.localeCompare(a.created_at)),

  moverStock(origen: string, destino: string, items: { producto_id: string; cantidad: number }[]) {
    const co = codigo(origen), cd = codigo(destino);
    for (const it of items) {
      const p = prods.find((x) => x.producto_id === it.producto_id);
      if (!p) continue;
      p.por[co] = Math.max(0, (p.por[co] ?? 0) - it.cantidad);
      p.por[cd] = (p.por[cd] ?? 0) + it.cantidad;
    }
    remitos.push(mkRemito("movimiento", origen, destino, "Movimiento entre depósitos"));
  },

  ocr(): IngresoItem[] {
    // Simula la lectura de una factura de proveedor local.
    return [
      { id: "i1", descripcion: "CAMARA SEG. WIFI PTZ EXTERIOR", sku_detectado: null,
        producto_id: "p4", cantidad: 12, costo_unit: 18500, confianza: 0.6, confirmado: false,
        producto: { sku: "CAM-WIFI-PORT", nombre: "Cámara de seguridad wifi" } },
      { id: "i2", descripcion: "TIMBRE WIFI C/ CAMARA", sku_detectado: "TIMBRE-WIFI-PORT",
        producto_id: "p5", cantidad: 6, costo_unit: 12300, confianza: 0.99, confirmado: true,
        producto: { sku: "TIMBRE-WIFI-PORT", nombre: "Timbre wifi con cámara" } },
      { id: "i3", descripcion: "ART. VARIOS ORGANIZADOR X6", sku_detectado: null,
        producto_id: null, cantidad: 6, costo_unit: 3400, confianza: 0, confirmado: false,
        producto: null },
    ];
  },

  confirmarIngreso(destino: string, items: { producto_id: string; cantidad: number }[]) {
    const cd = codigo(destino);
    for (const it of items) {
      const p = prods.find((x) => x.producto_id === it.producto_id);
      if (p) p.por[cd] = (p.por[cd] ?? 0) + it.cantidad;
    }
    remitos.push(mkRemito("ingreso", null, destino, "Ingreso por factura"));
  },

  cargarDevolucion(d: Partial<Devolucion> & { deposito_origen_id?: string }) {
    const dev: Devolucion = {
      id: "dev" + Math.random().toString(36).slice(2, 7),
      sku: d.sku ?? null, producto_id: d.producto_id ?? null, cantidad: d.cantidad ?? 1,
      canal: d.canal ?? null, venta_ref: d.venta_ref ?? null, motivo: d.motivo ?? null,
      estado: "retiro_generado", valor_perdida: null, created_at: new Date().toISOString(),
    };
    devoluciones.push(dev);
    remitos.push(mkRemito("devolucion_retiro", d.deposito_origen_id ?? null, "d-ofi", "Retiro de devolución"));
  },

  decidirDevolucion(id: string, apta: boolean, destino?: string, valor?: number) {
    const dev = devoluciones.find((x) => x.id === id);
    if (!dev) return;
    if (apta) {
      dev.estado = "apta";
      if (dev.producto_id && destino) {
        const p = prods.find((x) => x.producto_id === dev.producto_id);
        if (p) p.por[codigo(destino)] = (p.por[codigo(destino)] ?? 0) + dev.cantidad;
      }
    } else {
      dev.estado = "no_apta";
      dev.valor_perdida = valor ?? null;
    }
  },
};

function codigo(depId: string): string {
  return demoDepositos.find((d) => d.id === depId)?.codigo ?? depId;
}
