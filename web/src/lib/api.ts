// Capa de acceso a datos. Si hay credenciales de Supabase, habla con el backend
// real (lecturas por supabase-js, escrituras por Edge Functions). Si no, usa el
// MODO DEMO en memoria. Los componentes usan siempre esta interfaz.
import { supabase, isConnected, functionsBase, anonKey } from "./supabase.ts";
import { demo } from "./demo.ts";
import type {
  Deposito, StockConsolidado, Remito, Devolucion, IngresoItem, Auditoria, AltaProducto,
  Publicacion, PublicacionSugerencia,
} from "./types.ts";
import type { FinanzasConfig, CompraDetalle, VentaRaw, ProdRaw, ProductoFinRaw } from "./finanzas.ts";

export const connected = isConnected;

async function callFn<T = unknown>(fn: string, body: unknown): Promise<T> {
  const res = await fetch(`${functionsBase}/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${anonKey}`,
      "apikey": anonKey,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error ?? `Error ${res.status} en ${fn}`);
  }
  return data as T;
}

export const api = {
  connected,

  async lastSync(): Promise<string | null> {
    if (!connected) return new Date().toISOString();
    const { data } = await supabase!.from("sync_estado").select("ultima_ok").eq("job", "catalogo").maybeSingle();
    return data?.ultima_ok ?? null;
  },

  async syncNow(): Promise<void> {
    if (!connected) return;
    await callFn("stock-sync", {});
  },

  async depositos(): Promise<Deposito[]> {
    if (!connected) return demo.depositos();
    const { data, error } = await supabase!.from("depositos").select("id, codigo, nombre, es_full").order("orden");
    if (error) throw error;
    return data as Deposito[];
  },

  async stock(): Promise<StockConsolidado[]> {
    if (!connected) return demo.stock();
    const { data, error } = await supabase!.from("v_stock_canales").select("*").order("sku");
    if (error) throw error;
    return (data as Record<string, unknown>[]).map((r) => {
      const total = Number(r.total ?? 0);
      const min = Number(r.stock_minimo ?? 0);
      return {
        producto_id: r.producto_id, sku: r.sku, nombre: r.nombre,
        tipo: String(r.tipo ?? "P"), costo: Number(r.costo ?? 0),
        stock_minimo: min, total,
        por_deposito: (r.por_deposito ?? {}) as Record<string, number>,
        reservas: (r.reservas ?? {}) as Record<string, number>,
        por_canal: (r.por_canal ?? {}) as Record<string, number>,
        activo: Boolean(r.activo),
        estado: total <= 0 ? "sin_stock" : total <= min ? "reponer" : "ok",
      } as StockConsolidado;
    });
  },

  async syncCanales(): Promise<void> {
    if (!connected) return;
    await callFn("canal-sync", {});
  },

  async remitos(limit = 20): Promise<Remito[]> {
    if (!connected) return demo.remitos().slice(0, limit);
    const { data, error } = await supabase!
      .from("remitos").select("*").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return data as Remito[];
  },

  async devoluciones(): Promise<Devolucion[]> {
    if (!connected) return demo.devoluciones();
    const { data, error } = await supabase!
      .from("devoluciones")
      .select("*, items:devolucion_items(*)")
      .order("created_at", { ascending: false }).limit(80);
    if (error) throw error;
    return data as Devolucion[];
  },

  // ---- acciones ----
  async moverStock(origen: string, destino: string, items: { producto_id: string; cantidad: number }[]) {
    if (!connected) return demo.moverStock(origen, destino, items);
    await callFn("acciones", {
      accion: "mover_stock",
      payload: { origen_deposito_id: origen, destino_deposito_id: destino, items },
    });
  },

  // Proveedores de Contabilium (para completar IDProveedor al crear productos).
  async proveedoresCB(): Promise<{ id: number; nombre: string }[]> {
    if (!connected) return [];
    try {
      const r = await callFn<{ proveedores: { id: number; nombre: string }[] }>("proveedores", {});
      return r.proveedores ?? [];
    } catch { return []; }
  },

  async ocrIngreso(imageB64: string, mediaType: string, proveedor?: string, tipo = "local"): Promise<{ ingreso_id: string; items: IngresoItem[] }> {
    if (!connected) return { ingreso_id: "demo", items: demo.ocr() };
    return callFn("ocr-ingreso", { image_base64: imageB64, media_type: mediaType, proveedor, tipo });
  },

  async confirmarIngreso(ingresoId: string, destino: string, items: {
    id?: string; producto_id?: string | null; cantidad: number; aprender_alias?: string;
    costo_compra?: number;
    nuevo?: AltaProducto;
    variante?: AltaProducto & { base_producto_id: string };
  }[], compra?: {
    proveedor: string | null; fecha_compra: string; condicion_pago_dias: number; tasa_financiacion: number;
  }) {
    if (!connected) return demo.confirmarIngreso(destino, items.filter((i) => i.producto_id).map((i) => ({ id: i.id, producto_id: i.producto_id!, cantidad: i.cantidad })));
    await callFn("acciones", {
      accion: "confirmar_ingreso",
      payload: { ingreso_id: ingresoId, deposito_destino_id: destino, items, compra },
    });
  },

  // Carga MANUAL (Tienda Nube o cualquier caso sin API). Entra en 'por_retirar'.
  async cargarDevolucion(payload: {
    canal: string; venta_ref?: string; motivo?: string; foto_url?: string;
    deposito_retiro?: string; // GEN | FLX
    items: { sku?: string; producto_id?: string; cantidad: number }[];
  }) {
    if (!connected) return demo.cargarDevolucion(payload as any);
    await callFn("acciones", { accion: "cargar_devolucion", payload });
  },

  // Clasifica de qué depósito se retira: GEN (Genpol) o FLX (Flexit).
  async clasificarDevolucion(devolucion_id: string, deposito_retiro: "GEN" | "FLX") {
    if (!connected) return;
    await callFn("acciones", { accion: "clasificar_devolucion", payload: { devolucion_id, deposito_retiro } });
  },

  // Genera el remito de retiro con los SKUs reales → pasa a 'en_oficina'.
  async generarRemitoDevolucion(devolucion_id: string) {
    if (!connected) return;
    await callFn("acciones", { accion: "generar_remito_devolucion", payload: { devolucion_id } });
  },

  // Decide un ítem (SKU) ya en oficina: apto vuelve al stock, no apto es baja.
  async decidirItemDevolucion(payload: {
    item_id: string; apta: boolean; deposito_destino_id?: string;
    destino_no_apta?: string; valor_perdida?: number;
  }) {
    if (!connected) return;
    await callFn("acciones", { accion: "decidir_item_devolucion", payload });
  },

  async bajaProducto(producto_id: string, activo: boolean) {
    if (!connected) return demo.bajaProducto(producto_id, activo);
    await callFn("acciones", { accion: "baja_producto", payload: { producto_id, activo } });
  },

  // Setea el stock mínimo del producto (dispara la alerta de reposición).
  async setMinimo(producto_id: string, stock_minimo: number) {
    if (!connected) return;
    await callFn("producto-config", { producto_id, stock_minimo });
  },

  async recibirDevolucion(devolucion_id: string) {
    if (!connected) return demo.recibirDevolucion(devolucion_id);
    await callFn("acciones", { accion: "recibir_devolucion", payload: { devolucion_id } });
  },

  async ajusteInventario(producto_id: string, deposito_id: string, cantidad_contada: number) {
    if (!connected) return demo.ajusteInventario(producto_id, deposito_id, cantidad_contada);
    await callFn("acciones", { accion: "ajuste_inventario", payload: { producto_id, deposito_id, cantidad_contada } });
  },

  async deshacerRemito(remito_id: string) {
    if (!connected) return demo.deshacerRemito(remito_id);
    await callFn("acciones", { accion: "deshacer_remito", payload: { remito_id } });
  },

  async auditoria(limit = 60): Promise<Auditoria[]> {
    if (!connected) return demo.auditoria();
    const { data, error } = await supabase!
      .from("v_auditoria").select("*").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return data as Auditoria[];
  },

  // ---- Publicaciones (Mercado Libre, lectura) ----
  async publicaciones(): Promise<Publicacion[]> {
    if (!connected) return [];
    const { data, error } = await supabase!
      .from("publicaciones").select("*").order("precio", { ascending: false });
    if (error) throw error;
    return (data as Publicacion[]) ?? [];
  },

  async sugerenciasPub(): Promise<PublicacionSugerencia[]> {
    if (!connected) return [];
    const { data, error } = await supabase!
      .from("publicacion_sugerencias").select("*").order("updated_at", { ascending: false });
    if (error) throw error;
    return (data as PublicacionSugerencia[]) ?? [];
  },

  async syncPublicaciones(): Promise<void> {
    if (!connected) return;
    await callFn("publicaciones-sync", {});
  },

  async sugerirPublicacion(producto_id?: string): Promise<void> {
    if (!connected) return;
    await callFn("publicacion-sugerir", producto_id ? { producto_id } : { limit: 6 });
  },

  // ---- Finanzas (lectura de datos crudos; el cálculo va en el cliente) ----
  async finanzasConfig(): Promise<FinanzasConfig | null> {
    if (!connected) return null;
    const { data } = await supabase!.from("finanzas_config").select("*").eq("id", 1).maybeSingle();
    return (data as FinanzasConfig) ?? null;
  },
  async comprasDetalle(): Promise<CompraDetalle[]> {
    if (!connected) return [];
    const { data, error } = await supabase!.from("compras_detalle").select("*").order("fecha_compra", { ascending: false });
    if (error) throw error;
    return (data as CompraDetalle[]) ?? [];
  },
  async ventasRaw(): Promise<VentaRaw[]> {
    if (!connected) return [];
    const { data, error } = await supabase!.from("cb_ventas").select("fecha, origen, items").order("fecha", { ascending: false }).limit(3000);
    if (error) throw error;
    return (data as VentaRaw[]) ?? [];
  },
  async productosRaw(): Promise<ProdRaw[]> {
    if (!connected) return [];
    const { data, error } = await supabase!.from("productos").select("id, sku, nombre, costo, precio, tipo");
    if (error) throw error;
    return (data as ProdRaw[]) ?? [];
  },
  async productoFinanzasAll(): Promise<ProductoFinRaw[]> {
    if (!connected) return [];
    const { data, error } = await supabase!.from("producto_finanzas").select("*");
    if (error) throw error;
    return (data as ProductoFinRaw[]) ?? [];
  },
  async comisionesSku(): Promise<{ sku: string; comision_pct: number }[]> {
    if (!connected) return [];
    const { data, error } = await supabase!.from("publicaciones").select("sku, comision_pct").not("comision_pct", "is", null);
    if (error) throw error;
    return ((data as { sku: string; comision_pct: number }[]) ?? []).filter((r) => r.sku);
  },
  async guardarFinanzasConfig(config: Partial<FinanzasConfig>): Promise<void> {
    if (!connected) return;
    await callFn("finanzas-guardar", { accion: "config", config });
  },
  async guardarProductoFinanzas(producto_id: string, datos: {
    proveedor?: string | null; precio_compra?: number | null; condicion_pago_dias?: number;
    tasa_financiacion?: number; envio_flex?: number | null; condicion_pago_label?: string | null;
    canal_principal?: string | null;
  }): Promise<void> {
    if (!connected) return;
    await callFn("finanzas-guardar", { accion: "producto", producto_id, datos });
  },
  async productoFinanzas(producto_id: string): Promise<ProductoFinRaw | null> {
    if (!connected) return null;
    const { data } = await supabase!.from("producto_finanzas").select("*").eq("producto_id", producto_id).maybeSingle();
    return (data as ProductoFinRaw) ?? null;
  },

  // Sube una foto de devolución al storage y devuelve la URL pública.
  async subirFoto(file: File): Promise<string | null> {
    if (!connected || !supabase) return null;
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.name}`;
    const { error } = await supabase.storage.from("devoluciones").upload(path, file, { upsert: false });
    if (error) throw error;
    return supabase.storage.from("devoluciones").getPublicUrl(path).data.publicUrl;
  },
};
