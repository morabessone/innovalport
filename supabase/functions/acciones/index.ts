// ============================================================================
// acciones — operaciones de escritura que dispara el panel
// ----------------------------------------------------------------------------
// Cada acción: (1) actualiza el ESPEJO local (stock, remitos, devoluciones) y
// (2) ENCOLA el cambio hacia Contabilium en cb_queue (lo aplica el worker).
// El navegador nunca escribe en Contabilium ni ve la service role key.
//
// Acciones:
//   mover_stock        — remito de movimiento entre depósitos
//   confirmar_ingreso  — alta de stock desde una factura (OCR ya cargó los items)
//   cargar_devolucion  — registra la devolución y genera el remito de retiro
//   decidir_devolucion — apta (alta sin compra + NC) | no_apta (baja + pérdida)
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
      case "decidir_devolucion": return json(await decidirDevolucion(db, payload, actor));
      default: return json({ error: `acción desconocida: ${accion}` }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// ---- helpers --------------------------------------------------------------
async function enqueueAjuste(
  db: DB, productoId: string, depositoId: string, delta: number, motivo: string,
) {
  const [{ data: prod }, { data: dep }] = await Promise.all([
    db.from("productos").select("cb_producto_id").eq("id", productoId).single(),
    db.from("depositos").select("cb_deposito_id").eq("id", depositoId).single(),
  ]);
  await db.from("cb_queue").insert({
    accion: "ajuste_stock",
    payload: {
      cb_producto_id: prod?.cb_producto_id ?? null,
      cb_deposito_id: dep?.cb_deposito_id ?? null,
      producto_id: productoId,
      deposito_id: depositoId,
      delta,
      motivo,
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
    tipo,
    origen_deposito_id: origen,
    destino_deposito_id: destino,
    ref_tabla: ref?.tabla ?? null,
    ref_id: ref?.id ?? null,
    nota: nota ?? null,
    created_by: actor,
  }).select().single();
  if (error) throw error;
  if (items.length) {
    await db.from("remito_items").insert(
      items.map((i) => ({ remito_id: remito.id, producto_id: i.producto_id, cantidad: i.cantidad })),
    );
  }
  return remito;
}

// ---- mover_stock ----------------------------------------------------------
// payload: { origen_deposito_id, destino_deposito_id, items:[{producto_id, cantidad}], nota? }
async function moverStock(db: DB, p: Record<string, unknown>, actor: string) {
  const origen = String(p.origen_deposito_id);
  const destino = String(p.destino_deposito_id);
  const items = (p.items ?? []) as { producto_id: string; cantidad: number }[];
  if (origen === destino) throw new Error("origen y destino no pueden ser el mismo depósito");
  if (!items.length) throw new Error("no hay items para mover");

  for (const it of items) {
    await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: origen, p_delta: -it.cantidad });
    await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: destino, p_delta: it.cantidad });
    await enqueueAjuste(db, it.producto_id, origen, -it.cantidad, "Movimiento entre depósitos");
    await enqueueAjuste(db, it.producto_id, destino, it.cantidad, "Movimiento entre depósitos");
  }
  const remito = await crearRemito(db, "movimiento", origen, destino, items, actor, undefined, p.nota as string);
  await audit(db, "remito", remito.id, "movimiento", { origen, destino, items }, actor);
  return { ok: true, remito };
}

// ---- confirmar_ingreso ----------------------------------------------------
// payload: { ingreso_id, deposito_destino_id, items:[{id, producto_id, cantidad, aprender_alias?}] }
async function confirmarIngreso(db: DB, p: Record<string, unknown>, actor: string) {
  const ingresoId = String(p.ingreso_id);
  const destino = String(p.deposito_destino_id);
  const items = (p.items ?? []) as {
    id: string; producto_id: string; cantidad: number; aprender_alias?: string;
  }[];
  const confirmados = items.filter((i) => i.producto_id && i.cantidad > 0);
  if (!confirmados.length) throw new Error("no hay renglones confirmados con producto");

  for (const it of confirmados) {
    await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: destino, p_delta: it.cantidad });
    await enqueueAjuste(db, it.producto_id, destino, it.cantidad, "Ingreso por factura");
    await db.from("ingreso_items").update({ confirmado: true, producto_id: it.producto_id }).eq("id", it.id);
    // aprender el alias para futuros OCR
    if (it.aprender_alias) {
      await db.from("sku_aliases")
        .insert({ alias: it.aprender_alias, producto_id: it.producto_id, fuente: "ocr" })
        .then(() => {}, () => {}); // ignora duplicados
    }
  }

  await db.from("ingresos").update({
    estado: "confirmado",
    deposito_destino_id: destino,
    confirmado_at: new Date().toISOString(),
  }).eq("id", ingresoId);

  const remito = await crearRemito(
    db, "ingreso", null, destino,
    confirmados.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad })),
    actor, { tabla: "ingresos", id: ingresoId },
  );
  await audit(db, "ingreso", ingresoId, "confirmado", { destino, items: confirmados }, actor);
  return { ok: true, remito, alta: confirmados.length };
}

// ---- cargar_devolucion ----------------------------------------------------
// payload: { producto_id?, sku?, cantidad, canal, venta_ref?, motivo?, deposito_origen_id }
async function cargarDevolucion(db: DB, p: Record<string, unknown>, actor: string) {
  // Destino siempre la Oficina (todas las devoluciones vuelven ahí a revisarse).
  const { data: ofi } = await db.from("depositos").select("id").eq("codigo", "OFI").single();

  const { data: dev, error } = await db.from("devoluciones").insert({
    producto_id: (p.producto_id as string) ?? null,
    sku: (p.sku as string) ?? null,
    cantidad: Number(p.cantidad ?? 1),
    canal: (p.canal as string) ?? null,
    venta_ref: (p.venta_ref as string) ?? null,
    motivo: (p.motivo as string) ?? null,
    deposito_origen_id: (p.deposito_origen_id as string) ?? null,
    deposito_destino_id: ofi?.id ?? null,
    estado: "retiro_generado",
  }).select().single();
  if (error) throw error;

  // Remito de retiro automático (desde el depósito de origen hacia la oficina).
  const remito = await crearRemito(
    db, "devolucion_retiro",
    (p.deposito_origen_id as string) ?? null, ofi?.id ?? null,
    dev.producto_id ? [{ producto_id: dev.producto_id, cantidad: dev.cantidad }] : [],
    actor, { tabla: "devoluciones", id: dev.id },
    "Retiro de devolución",
  );
  await audit(db, "devolucion", dev.id, "cargada", p, actor);
  return { ok: true, devolucion: dev, remito };
}

// ---- decidir_devolucion ---------------------------------------------------
// payload: { devolucion_id, apta:bool, deposito_destino_id?, valor_perdida?, cb_comprobante_id? }
async function decidirDevolucion(db: DB, p: Record<string, unknown>, actor: string) {
  const id = String(p.devolucion_id);
  const apta = Boolean(p.apta);
  const { data: dev } = await db.from("devoluciones").select("*").eq("id", id).single();
  if (!dev) throw new Error("devolución no encontrada");

  if (apta) {
    // Alta sin compra: reingresa al stock del depósito elegido.
    const destino = String(p.deposito_destino_id ?? dev.deposito_destino_id);
    if (dev.producto_id) {
      await db.rpc("ajustar_stock_espejo", { p_producto: dev.producto_id, p_deposito: destino, p_delta: dev.cantidad });
      await enqueueAjuste(db, dev.producto_id, destino, dev.cantidad, "Devolución apta (alta sin compra)");
    }
    // Nota de crédito automática, si tenemos el comprobante de la venta original.
    if (p.cb_comprobante_id) {
      await db.from("cb_queue").insert({
        accion: "nota_credito",
        payload: { cb_comprobante_id: String(p.cb_comprobante_id), devolucion_id: id },
        ref_tabla: "devoluciones", ref_id: id,
      });
    }
    await db.from("devoluciones").update({
      estado: "apta", apta: true, deposito_destino_id: destino, decidido_por: actor,
    }).eq("id", id);
  } else {
    // No apta: baja definitiva + registro de la pérdida valorizada.
    await db.from("devoluciones").update({
      estado: "no_apta", apta: false,
      valor_perdida: p.valor_perdida ?? null, decidido_por: actor,
    }).eq("id", id);
  }
  await audit(db, "devolucion", id, apta ? "apta" : "no_apta", p, actor);
  return { ok: true };
}
