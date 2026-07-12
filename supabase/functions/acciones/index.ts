// ============================================================================
// acciones — operaciones de escritura que dispara el panel
// Cada acción actualiza el espejo local y encola el cambio hacia Contabilium.
// ============================================================================
import { preflight, json } from "../_shared/cors.ts";
import { serviceClient, audit } from "../_shared/supabase.ts";

type DB = ReturnType<typeof serviceClient>;

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ error: "usar POST" }, 405);
  const db = serviceClient();
  try {
    const { accion, payload, actor = "panel" } = await req.json();
    switch (accion) {
      case "mover_stock":        return json(await moverStock(db, payload, actor));
      case "confirmar_ingreso":  return json(await confirmarIngreso(db, payload, actor));
      case "cargar_devolucion":  return json(await cargarDevolucion(db, payload, actor));
      case "recibir_devolucion": return json(await recibirDevolucion(db, payload, actor));
      case "decidir_devolucion": return json(await decidirDevolucion(db, payload, actor));
      case "baja_producto":      return json(await bajaProducto(db, payload, actor));
      case "ajuste_inventario":  return json(await ajusteInventario(db, payload, actor));
      case "deshacer_remito":    return json(await deshacerRemito(db, payload, actor));
      default: return json({ error: `acción desconocida: ${accion}` }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

async function enqueueAjuste(db: DB, productoId: string, depositoId: string, delta: number, motivo: string) {
  const [{ data: prod }, { data: dep }] = await Promise.all([
    db.from("productos").select("cb_producto_id").eq("id", productoId).single(),
    db.from("depositos").select("cb_deposito_id").eq("id", depositoId).single(),
  ]);
  await db.from("cb_queue").insert({
    accion: "ajuste_stock",
    payload: {
      cb_producto_id: prod?.cb_producto_id ?? null,
      cb_deposito_id: dep?.cb_deposito_id ?? null,
      producto_id: productoId, deposito_id: depositoId, delta, motivo,
    },
    ref_tabla: "stock",
  });
}

async function crearRemito(
  db: DB, tipo: string, origen: string | null, destino: string | null,
  items: { producto_id: string; cantidad: number }[], actor: string,
  ref?: { tabla: string; id: string }, nota?: string,
) {
  const { data: remito, error } = await db.from("remitos").insert({
    tipo, origen_deposito_id: origen, destino_deposito_id: destino,
    ref_tabla: ref?.tabla ?? null, ref_id: ref?.id ?? null, nota: nota ?? null, created_by: actor,
  }).select().single();
  if (error) throw error;
  if (items.length) {
    await db.from("remito_items").insert(
      items.map((i) => ({ remito_id: remito.id, producto_id: i.producto_id, cantidad: i.cantidad })),
    );
  }
  return remito;
}

// Movimiento entre depósitos: INTERNO (no cambia el total en Contabilium).
async function moverStock(db: DB, p: Record<string, unknown>, actor: string) {
  const origen = String(p.origen_deposito_id);
  const destino = String(p.destino_deposito_id);
  const items = (p.items ?? []) as { producto_id: string; cantidad: number }[];
  if (origen === destino) throw new Error("origen y destino no pueden ser el mismo depósito");
  if (!items.length) throw new Error("no hay items para mover");
  for (const it of items) {
    await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: origen, p_delta: -it.cantidad });
    await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: destino, p_delta: it.cantidad });
  }
  const remito = await crearRemito(db, "movimiento", origen, destino, items, actor, undefined, p.nota as string);
  await audit(db, "remito", remito.id, "movimiento", { origen, destino, items }, actor);
  return { ok: true, remito };
}

// Ingreso: SUMA stock real -> cambia el total, se encola ajuste a Contabilium.
async function confirmarIngreso(db: DB, p: Record<string, unknown>, actor: string) {
  const ingresoId = String(p.ingreso_id);
  const destino = String(p.deposito_destino_id);
  const items = (p.items ?? []) as { id?: string; producto_id: string; cantidad: number; aprender_alias?: string }[];
  const confirmados = items.filter((i) => i.producto_id && i.cantidad > 0);
  if (!confirmados.length) throw new Error("no hay renglones confirmados con producto");
  for (const it of confirmados) {
    await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: destino, p_delta: it.cantidad });
    await enqueueAjuste(db, it.producto_id, destino, it.cantidad, "Ingreso por factura");
    if (it.id) await db.from("ingreso_items").update({ confirmado: true, producto_id: it.producto_id }).eq("id", it.id);
    if (it.aprender_alias) {
      await db.from("sku_aliases").insert({ alias: it.aprender_alias, producto_id: it.producto_id, fuente: "ocr" }).then(() => {}, () => {});
    }
  }
  if (ingresoId && ingresoId !== "manual") {
    await db.from("ingresos").update({ estado: "confirmado", deposito_destino_id: destino, confirmado_at: new Date().toISOString() }).eq("id", ingresoId);
  }
  const remito = await crearRemito(db, "ingreso", null, destino, confirmados.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad })), actor, ingresoId && ingresoId !== "manual" ? { tabla: "ingresos", id: ingresoId } : undefined);
  await audit(db, "ingreso", remito.id, "confirmado", { destino, items: confirmados }, actor);
  return { ok: true, remito, alta: confirmados.length };
}

async function cargarDevolucion(db: DB, p: Record<string, unknown>, actor: string) {
  const { data: ofi } = await db.from("depositos").select("id").eq("codigo", "OFI").single();
  const { data: dev, error } = await db.from("devoluciones").insert({
    producto_id: (p.producto_id as string) ?? null,
    sku: (p.sku as string) ?? null,
    cantidad: Number(p.cantidad ?? 1),
    canal: (p.canal as string) ?? null,
    venta_ref: (p.venta_ref as string) ?? null,
    motivo: (p.motivo as string) ?? null,
    foto_url: (p.foto_url as string) ?? null,
    deposito_origen_id: (p.deposito_origen_id as string) ?? null,
    deposito_destino_id: ofi?.id ?? null,
    estado: "retiro_generado",
  }).select().single();
  if (error) throw error;
  const remito = await crearRemito(
    db, "devolucion_retiro", (p.deposito_origen_id as string) ?? null, ofi?.id ?? null,
    dev.producto_id ? [{ producto_id: dev.producto_id, cantidad: dev.cantidad }] : [],
    actor, { tabla: "devoluciones", id: dev.id }, "Retiro de devolución",
  );
  await audit(db, "devolucion", dev.id, "cargada", p, actor);
  return { ok: true, devolucion: dev, remito };
}

// Marca que la devolución llegó a la oficina (lista para revisar).
async function recibirDevolucion(db: DB, p: Record<string, unknown>, actor: string) {
  const id = String(p.devolucion_id);
  await db.from("devoluciones").update({ estado: "en_oficina" }).eq("id", id);
  await audit(db, "devolucion", id, "en_oficina", {}, actor);
  return { ok: true };
}

async function decidirDevolucion(db: DB, p: Record<string, unknown>, actor: string) {
  const id = String(p.devolucion_id);
  const apta = Boolean(p.apta);
  const { data: dev } = await db.from("devoluciones").select("*").eq("id", id).single();
  if (!dev) throw new Error("devolución no encontrada");
  if (apta) {
    const destino = String(p.deposito_destino_id ?? dev.deposito_destino_id);
    if (dev.producto_id) {
      await db.rpc("ajustar_stock_espejo", { p_producto: dev.producto_id, p_deposito: destino, p_delta: dev.cantidad });
      await enqueueAjuste(db, dev.producto_id, destino, dev.cantidad, "Devolución apta (alta sin compra)");
    }
    if (p.cb_comprobante_id) {
      await db.from("cb_queue").insert({ accion: "nota_credito", payload: { cb_comprobante_id: String(p.cb_comprobante_id), devolucion_id: id }, ref_tabla: "devoluciones", ref_id: id });
    }
    await db.from("devoluciones").update({ estado: "apta", apta: true, deposito_destino_id: destino, decidido_por: actor }).eq("id", id);
  } else {
    // pérdida valorizada automática con el costo real del producto
    let perdida: number | null = (p.valor_perdida as number) ?? null;
    if (perdida == null && dev.producto_id) {
      const { data: prod } = await db.from("productos").select("costo").eq("id", dev.producto_id).single();
      if (prod?.costo != null) perdida = Number(prod.costo) * Number(dev.cantidad);
    }
    await db.from("devoluciones").update({
      estado: "no_apta", apta: false,
      valor_perdida: perdida,
      destino_no_apta: (p.destino_no_apta as string) ?? null,
      decidido_por: actor,
    }).eq("id", id);
  }
  await audit(db, "devolucion", id, apta ? "apta" : "no_apta", p, actor);
  return { ok: true };
}

async function bajaProducto(db: DB, p: Record<string, unknown>, actor: string) {
  const id = String(p.producto_id);
  const activo = Boolean(p.activo);
  await db.from("productos").update({ activo }).eq("id", id);
  const { data: prod } = await db.from("productos").select("cb_producto_id, sku").eq("id", id).single();
  await db.from("cb_queue").insert({ accion: "estado_producto", payload: { cb_producto_id: prod?.cb_producto_id ?? null, sku: prod?.sku ?? null, activo }, ref_tabla: "productos", ref_id: id });
  await audit(db, "producto", id, activo ? "reactivar" : "baja", p, actor);
  return { ok: true };
}

// Ajuste de inventario: fija el stock de un depósito al valor contado y registra la diferencia.
async function ajusteInventario(db: DB, p: Record<string, unknown>, actor: string) {
  const productoId = String(p.producto_id);
  const depositoId = String(p.deposito_id);
  const contada = Math.max(0, Math.round(Number(p.cantidad_contada ?? 0)));
  const { data: st } = await db.from("stock").select("cantidad").eq("producto_id", productoId).eq("deposito_id", depositoId).maybeSingle();
  const sistema = Number(st?.cantidad ?? 0);
  const delta = contada - sistema;
  await db.rpc("ajustar_stock_espejo", { p_producto: productoId, p_deposito: depositoId, p_delta: delta });
  await db.from("conteos").insert({ deposito_id: depositoId, producto_id: productoId, cantidad_sistema: sistema, cantidad_contada: contada, diferencia: delta, actor });
  if (delta !== 0) await enqueueAjuste(db, productoId, depositoId, delta, "Ajuste de inventario");
  await audit(db, "inventario", productoId, "ajuste", { depositoId, sistema, contada, delta }, actor);
  return { ok: true, sistema, contada, delta };
}

// Deshacer un remito de movimiento: revierte el stock y lo marca anulado.
async function deshacerRemito(db: DB, p: Record<string, unknown>, actor: string) {
  const id = String(p.remito_id);
  const { data: remito } = await db.from("remitos").select("*").eq("id", id).single();
  if (!remito) throw new Error("remito no encontrado");
  if (remito.tipo !== "movimiento") throw new Error("solo se pueden deshacer movimientos");
  if (remito.estado === "anulado") throw new Error("el remito ya está anulado");
  const { data: items } = await db.from("remito_items").select("producto_id, cantidad").eq("remito_id", id);
  for (const it of items ?? []) {
    if (!it.producto_id) continue;
    // revertir: devolver al origen, sacar del destino
    if (remito.destino_deposito_id) await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: remito.destino_deposito_id, p_delta: -it.cantidad });
    if (remito.origen_deposito_id) await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: remito.origen_deposito_id, p_delta: it.cantidad });
  }
  await db.from("remitos").update({ estado: "anulado" }).eq("id", id);
  await audit(db, "remito", id, "anulado", {}, actor);
  return { ok: true };
}
