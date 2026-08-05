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
  tipo: string;         // P producto | V variante | C combo
  costo: number;
  stock_minimo: number;
  total: number;
  por_deposito: Record<string, number>;  // GEN, FULL, FLX, OFI
  por_canal: Record<string, number>;      // ml_full, ml_flex, tn
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

export interface DevolucionItem {
  id: string;
  devolucion_id: string;
  sku: string | null;
  producto_id: string | null;
  cantidad: number;
  apta: boolean | null;          // null = sin decidir
  destino_no_apta: string | null;
  valor_perdida: number | null;
}

export interface Devolucion {
  id: string;
  sku: string | null;
  producto_id: string | null;
  cantidad: number;
  canal: string | null;
  venta_ref: string | null;
  motivo: string | null;
  estado: string;    // en_proceso | por_retirar | en_oficina | apta | no_apta | parcial
  origen: string;    // ml_api | manual
  deposito_retiro_id: string | null;
  entregada_at: string | null;
  valor_perdida: number | null;
  destino_no_apta: string | null;
  foto_url: string | null;
  created_at: string;
  items?: DevolucionItem[];
}

export interface Auditoria {
  id: string;
  entidad: string;
  entidad_id: string | null;
  accion: string;
  actor: string | null;
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
