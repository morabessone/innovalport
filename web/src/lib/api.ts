// Capa de acceso a datos. Si hay credenciales de Supabase, habla con el backend
// real (lecturas por supabase-js, escrituras por Edge Functions). Si no, usa el
// MODO DEMO en memoria. Los componentes usan siempre esta interfaz.
import { supabase, isConnected, functionsBase, anonKey } from "./supabase.ts";
import { demo } from "./demo.ts";
import type {
  Deposito, StockConsolidado, Remito, Devolucion, IngresoItem, Auditoria,
} from "./types.ts";

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
      .from("devoluciones").select("*").order("created_at", { ascending: false }).limit(50);
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

  async ocrIngreso(imageB64: string, mediaType: string, proveedor?: string, tipo = "local"): Promise<{ ingreso_id: string; items: IngresoItem[] }> {
    if (!connected) return { ingreso_id: "demo", items: demo.ocr() };
    return callFn("ocr-ingreso", { image_base64: imageB64, media_type: mediaType, proveedor, tipo });
  },

  async confirmarIngreso(ingresoId: string, destino: string, items: {
    id?: string; producto_id?: string | null; cantidad: number; aprender_alias?: string;
    nuevo?: { sku: string; nombre: string; costo?: number };
    variante?: { sku: string; nombre: string; base_producto_id: string; costo?: number };
  }[]) {
    if (!connected) return demo.confirmarIngreso(destino, items.filter((i) => i.producto_id).map((i) => ({ id: i.id, producto_id: i.producto_id!, cantidad: i.cantidad })));
    await callFn("acciones", {
      accion: "confirmar_ingreso",
      payload: { ingreso_id: ingresoId, deposito_destino_id: destino, items },
    });
  },

  async cargarDevolucion(payload: {
    producto_id?: string; sku?: string; cantidad: number; canal: string;
    venta_ref?: string; motivo?: string; deposito_origen_id: string; foto_url?: string;
  }) {
    if (!connected) return demo.cargarDevolucion(payload);
    await callFn("acciones", { accion: "cargar_devolucion", payload });
  },

  async decidirDevolucion(payload: {
    devolucion_id: string; apta: boolean; deposito_destino_id?: string;
    valor_perdida?: number; destino_no_apta?: string; cb_comprobante_id?: string;
  }) {
    if (!connected) return demo.decidirDevolucion(payload.devolucion_id, payload.apta, payload.deposito_destino_id, payload.valor_perdida);
    await callFn("acciones", { accion: "decidir_devolucion", payload });
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

  // Sube una foto de devolución al storage y devuelve la URL pública.
  async subirFoto(file: File): Promise<string | null> {
    if (!connected || !supabase) return null;
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.name}`;
    const { error } = await supabase.storage.from("devoluciones").upload(path, file, { upsert: false });
    if (error) throw error;
    return supabase.storage.from("devoluciones").getPublicUrl(path).data.publicUrl;
  },
};
