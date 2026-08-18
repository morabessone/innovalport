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
  reservas: Record<string, number>;       // unidades reservadas por depósito (Contabilium)
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

// Alta de producto (para crear COMPLETO en Contabilium desde un Ingreso).
export interface AltaProducto {
  sku: string;
  nombre: string;
  costo?: number;
  precio?: number;
  iva?: number;
  codigo_barras?: string;
  codigo_proveedor?: string;
  id_proveedor_cb?: number | null;
  descripcion?: string;
  stock_minimo?: number;
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

// ---- Publicaciones (Mercado Libre, espejo de lectura) ----
export interface Alerta { tipo: string; nivel: "critico" | "alerta" | "info"; texto: string; }
export interface CatalogInfo { price_to_win?: number | null; precio_ganador?: number | null; ganando?: boolean; status?: string | null; catalog_product_id?: string | null; }
export interface Sugerencia { accion?: "subir" | "bajar" | "mantener"; precio_sugerido?: number | null; motivo?: string; margen_en_sugerido?: number | null; piso?: number | null; }

export interface Publicacion {
  ml_item_id: string;
  sku: string | null;
  producto_id: string | null;
  titulo: string | null;
  categoria_id: string | null;
  estado: string | null;
  precio: number;
  moneda: string;
  available_quantity: number;
  sold_quantity: number;
  health: number | null;
  listing_type_id: string | null;
  logistic_type: string | null;
  permalink: string | null;
  thumbnail: string | null;
  is_catalog: boolean;
  catalog_product_id: string | null;
  catalog: CatalogInfo;
  costo: number | null;
  precio_min: number | null;
  margen_pct: number | null;
  sugerencia: Sugerencia;
  alertas: Alerta[];
  atributos: { id?: string; name?: string; value_name?: string }[];
  metrics: Record<string, unknown>;
  updated_at: string;
}

export interface PublicacionSugerencia {
  id: string;
  producto_id: string | null;
  sku: string | null;
  titulo_sugerido: string | null;
  descripcion_sugerida: string | null;
  categoria_sugerida: string | null;
  atributos: { nombre?: string; valor?: string }[];
  imagenes: string[];
  fuente_imagenes: string | null;
  estado: string;
  updated_at: string;
}
