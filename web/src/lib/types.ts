export type EstadoStock = "ok" | "reponer" | "sin_stock";

export interface Deposito {
  id: string;
  codigo: string;   // GEN | FLX | FULL | OFI
  nombre: string;
  es_full: boolean;
}

export interface StockConsolidado {
  producto_id: string;
  sku: string;
  nombre: string;
  stock_minimo: number;
  total: number;
  por_deposito: Record<string, number>;
  estado: EstadoStock;
  activo: boolean;
}

export interface Remito {
  id: string;
  numero_int: number;
  tipo: string;      // ingreso | movimiento | egreso | devolucion_retiro
  origen_deposito_id: string | null;
  destino_deposito_id: string | null;
  estado: string;
  nota: string | null;
  created_at: string;
}

export interface Devolucion {
  id: string;
  sku: string | null;
  producto_id: string | null;
  cantidad: number;
  canal: string | null;
  venta_ref: string | null;
  motivo: string | null;
  estado: string;    // cargada | retiro_generado | en_oficina | apta | no_apta
  valor_perdida: number | null;
  created_at: string;
}

export interface IngresoItem {
  id: string;
  descripcion: string;
  sku_detectado: string | null;
  producto_id: string | null;
  cantidad: number;
  costo_unit: number | null;
  confianza: number;
  confirmado: boolean;
  producto?: { sku: string; nombre: string } | null;
}

export interface SyncEstado {
  ultima_ok: string | null;
}
