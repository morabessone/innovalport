// ============================================================================
// acciones — operaciones de escritura que dispara el panel
// Cada acción actualiza el espejo local y encola el cambio hacia Contabilium.
// ============================================================================
// Self-contained (sin imports de _shared) para poder desplegar por MCP sin
// que se rompa el path relativo. Los helpers van inline abajo.
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return null;
}
function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function audit(db: SupabaseClient, entidad: string, entidad_id: string | null, accion: string, detalle: unknown, actor = "sistema"): Promise<void> {
  try { await db.from("auditoria").insert({ entidad, entidad_id, accion, detalle, actor }); } catch (_e) { /* no frenar */ }
}

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
      case "clasificar_devolucion": return json(await clasificarDevolucion(db, payload, actor));
      case "generar_remito_devolucion": return json(await generarRemitoDevolucion(db, payload, actor));
      case "decidir_item_devolucion": return json(await decidirItemDevolucion(db, payload, actor));
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

  // Regla del negocio: la salida de Oficina NO pide remito; el resto sí.
  const { data: depO } = await db.from("depositos").select("codigo").eq("id", origen).maybeSingle();
  const saleDeOficina = depO?.codigo === "OFI";

  for (const it of items) {
    // Espejo local (se reconcilia con Contabilium en la próxima sync).
    await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: origen, p_delta: -it.cantidad });
    await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: destino, p_delta: it.cantidad });
    // Contabilium no tiene remito de traslado por API: el movimiento se refleja
    // como DOS ajustes de stock (−origen, +destino). Interno: el total no cambia.
    await enqueueAjuste(db, it.producto_id, origen, -it.cantidad, "Traslado entre depósitos");
    await enqueueAjuste(db, it.producto_id, destino, it.cantidad, "Traslado entre depósitos");
  }

  // El remito es el documento del retiro físico (lo genera la app), salvo OFI.
  let remito = null;
  if (!saleDeOficina) {
    remito = await crearRemito(db, "movimiento", origen, destino, items, actor, undefined, p.nota as string);
  }
  await audit(db, "remito", remito?.id ?? null, "movimiento", { origen, destino, items, remito: !!remito, saleDeOficina }, actor);
  return { ok: true, remito, remito_generado: !saleDeOficina };
}

// Ingreso: SUMA stock real -> cambia el total, se encola ajuste a Contabilium.
// Resuelve el producto_id de un renglón: existente, nuevo o variante.
// Crea el producto en la app (cb_pendiente=true) si es nuevo/variante.
async function resolverProducto(db: DB, it: Record<string, any>, actor: string): Promise<string | null> {
  if (it.producto_id) return String(it.producto_id);
  const nuevo = it.nuevo || it.variante;
  if (!nuevo) return null;
  const esVariante = !!it.variante;
  const sku = String(nuevo.sku ?? "").trim();
  const nombre = String(nuevo.nombre ?? "").trim() || sku;
  if (!sku) return null;
  const { data: ya } = await db.from("productos").select("id").ilike("sku", sku).maybeSingle();
  if (ya?.id) return String(ya.id);
  let baseSku: string | null = null;
  if (esVariante && nuevo.base_producto_id) {
    const { data: padre } = await db.from("productos").select("sku").eq("id", String(nuevo.base_producto_id)).maybeSingle();
    baseSku = padre?.sku ?? null;
  }
  const costo = Number(nuevo.costo ?? 0) || 0;
  const precio = nuevo.precio != null ? Number(nuevo.precio) || 0 : null;
  const { data: creado, error } = await db.from("productos").insert({
    sku, nombre, tipo: esVariante ? "V" : "P", activo: true,
    costo, precio, base_sku: baseSku,
    stock_minimo: Math.round(Number(nuevo.stock_minimo ?? 0)) || 0,
    codigo_barras: (nuevo.codigo_barras as string) ?? null,
    cb_pendiente: true,
  }).select("id").single();
  if (error) throw new Error(`No se pudo crear ${sku}: ${error.message}`);
  // Encolar el ALTA COMPLETA en Contabilium (dry-run hasta habilitar escritura).
  await db.from("cb_queue").insert({
    accion: "crear_producto",
    payload: {
      producto_id: creado.id, sku, nombre,
      costo, precio: precio ?? undefined,
      iva: nuevo.iva != null ? Number(nuevo.iva) : undefined,
      codigo_barras: nuevo.codigo_barras ?? undefined,
      codigo_proveedor: nuevo.codigo_proveedor ?? undefined,
      id_proveedor_cb: nuevo.id_proveedor_cb ?? undefined,
      descripcion: nuevo.descripcion ?? undefined,
      stock_minimo: nuevo.stock_minimo != null ? Number(nuevo.stock_minimo) : undefined,
    },
    ref_tabla: "productos", ref_id: creado.id,
  });
  await audit(db, "producto", creado.id, esVariante ? "alta_variante" : "alta_nuevo", { sku, nombre, base_sku: baseSku }, actor);
  return String(creado.id);
}

async function confirmarIngreso(db: DB, p: Record<string, unknown>, actor: string) {
  const ingresoId = String(p.ingreso_id);
  const destino = String(p.deposito_destino_id);
  const items = (p.items ?? []) as Record<string, any>[];
  const compra = (p.compra ?? null) as Record<string, any> | null;
  const confirmados: { producto_id: string; cantidad: number; id?: string; aprender_alias?: string; costo_compra?: number }[] = [];
  let creados = 0;
  for (const it of items) {
    if (!(Number(it.cantidad) > 0)) continue;
    const nuevoFlag = !it.producto_id && (it.nuevo || it.variante);
    const pid = await resolverProducto(db, it, actor);
    if (!pid) continue;
    if (nuevoFlag) creados++;
    confirmados.push({ producto_id: pid, cantidad: Number(it.cantidad), id: it.id, aprender_alias: it.aprender_alias, costo_compra: it.costo_compra != null ? Number(it.costo_compra) : undefined });
  }
  if (!confirmados.length) throw new Error("no hay renglones con producto asignado");
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

  // Registrar la compra por línea (para el análisis financiero / ciclo de caja).
  if (compra) {
    const cond = Number(compra.condicion_pago_dias ?? 0) || 0;
    const fCompra = String(compra.fecha_compra ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
    const fPago = new Date(new Date(fCompra + "T00:00:00Z").getTime() + cond * 86400_000).toISOString().slice(0, 10);
    for (const it of confirmados) {
      const { data: prod } = await db.from("productos").select("sku, costo").eq("id", it.producto_id).maybeSingle();
      const precioUnit = it.costo_compra ?? Number(prod?.costo ?? 0) ?? 0;
      await db.from("compras_detalle").insert({
        ingreso_id: ingresoId && ingresoId !== "manual" ? ingresoId : null,
        producto_id: it.producto_id, sku: prod?.sku ?? null,
        proveedor: compra.proveedor ?? null,
        precio_unitario: precioUnit, cantidad: it.cantidad,
        fecha_compra: fCompra, condicion_pago_dias: cond,
        fecha_pago_programada: fPago, tasa_financiacion: Number(compra.tasa_financiacion ?? 0) || 0,
      }).then(() => {}, () => {});
    }
  }

  await audit(db, "ingreso", remito.id, "confirmado", { destino, items: confirmados, creados }, actor);
  return { ok: true, remito, alta: confirmados.length, productos_nuevos: creados };
}

// Devuelve el depósito de retiro según el canal: ML Full → Genpol,
// Flex / Tienda Nube → Flexit. Se puede forzar con deposito_retiro (código).
async function depositoRetiro(db: DB, canal: string | null, codigoForzado?: string | null) {
  const codigo = codigoForzado ?? (canal === "ML" || canal === "ml_full" ? "GEN" : "FLX");
  const { data } = await db.from("depositos").select("id, codigo").eq("codigo", codigo).maybeSingle();
  return data ?? null;
}

// Resuelve producto_id a partir de un SKU (para los ítems que trae ML/manual).
async function productoPorSku(db: DB, sku?: string | null): Promise<string | null> {
  if (!sku) return null;
  const { data } = await db.from("productos").select("id").ilike("sku", String(sku).trim()).maybeSingle();
  return data?.id ?? null;
}

// Carga MANUAL de una devolución (Tienda Nube o cualquier caso sin API).
// Entra directo en 'por_retirar' clasificada por depósito, con sus SKUs reales.
// Payload: { canal, venta_ref?, motivo?, foto_url?, deposito_retiro? (GEN|FLX),
//            items: [{ sku, producto_id?, cantidad }] }
async function cargarDevolucion(db: DB, p: Record<string, unknown>, actor: string) {
  const canal = (p.canal as string) ?? null;
  const dep = await depositoRetiro(db, canal, (p.deposito_retiro as string) ?? null);
  const itemsIn = ((p.items as Record<string, unknown>[]) ?? []).filter((i) => Number(i.cantidad) > 0);
  if (!itemsIn.length) throw new Error("la devolución no tiene ítems");

  const totalUnidades = itemsIn.reduce((a, i) => a + Number(i.cantidad), 0);
  const { data: dev, error } = await db.from("devoluciones").insert({
    origen: "manual",
    sku: itemsIn.length === 1 ? (itemsIn[0].sku as string) ?? null : null,
    producto_id: null,
    cantidad: totalUnidades,
    canal,
    venta_ref: (p.venta_ref as string) ?? null,
    motivo: (p.motivo as string) ?? null,
    foto_url: (p.foto_url as string) ?? null,
    deposito_retiro_id: dep?.id ?? null,
    estado: "por_retirar",
  }).select().single();
  if (error) throw error;

  for (const it of itemsIn) {
    const pid = (it.producto_id as string) ?? await productoPorSku(db, it.sku as string);
    await db.from("devolucion_items").insert({
      devolucion_id: dev.id, sku: (it.sku as string) ?? null,
      producto_id: pid, cantidad: Number(it.cantidad),
    });
  }
  await audit(db, "devolucion", dev.id, "por_retirar", { origen: "manual", items: itemsIn.length }, actor);
  return { ok: true, devolucion: dev };
}

// Clasifica (o reclasifica) de qué depósito se retira: GEN o FLX.
async function clasificarDevolucion(db: DB, p: Record<string, unknown>, actor: string) {
  const id = String(p.devolucion_id);
  const dep = await depositoRetiro(db, null, String(p.deposito_retiro));
  if (!dep) throw new Error("depósito de retiro inválido (usar GEN o FLX)");
  const { data: dev } = await db.from("devoluciones").select("estado").eq("id", id).single();
  const patch: Record<string, unknown> = { deposito_retiro_id: dep.id };
  // Si venía 'en proceso' (ML), clasificar también la habilita para retirar.
  if (dev?.estado === "en_proceso") patch.estado = "por_retirar";
  await db.from("devoluciones").update(patch).eq("id", id);
  await audit(db, "devolucion", id, "clasificada", { deposito: dep.codigo }, actor);
  return { ok: true };
}

// Genera el remito de retiro usando los SKUs reales de la devolución.
// La mercadería se retira de GEN/FLX y entra a Oficina (queda a revisar).
async function generarRemitoDevolucion(db: DB, p: Record<string, unknown>, actor: string) {
  const id = String(p.devolucion_id);
  const { data: dev } = await db.from("devoluciones").select("*").eq("id", id).single();
  if (!dev) throw new Error("devolución no encontrada");
  if (dev.estado !== "por_retirar") throw new Error("la devolución no está lista para retirar");
  if (!dev.deposito_retiro_id) throw new Error("clasificá primero de qué depósito se retira (Genpol o Flexit)");

  const { data: ofi } = await db.from("depositos").select("id").eq("codigo", "OFI").single();
  const { data: items } = await db.from("devolucion_items").select("*").eq("devolucion_id", id);
  const conProducto = (items ?? []).filter((i) => i.producto_id);

  // La mercadería devuelta ingresa físicamente a Oficina (aún sin decidir).
  for (const it of conProducto) {
    await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: ofi!.id, p_delta: it.cantidad });
    await enqueueAjuste(db, it.producto_id, ofi!.id, it.cantidad, "Devolución retirada a Oficina");
  }
  const remito = await crearRemito(
    db, "devolucion_retiro", dev.deposito_retiro_id, ofi!.id,
    conProducto.map((i) => ({ producto_id: i.producto_id as string, cantidad: i.cantidad })),
    actor, { tabla: "devoluciones", id }, "Retiro de devolución (SKUs reales)",
  );
  await db.from("devoluciones").update({ estado: "en_oficina", remito_id: remito.id, deposito_destino_id: ofi!.id }).eq("id", id);
  await audit(db, "devolucion", id, "remito_generado", { remito: remito.id, skus: conProducto.length }, actor);
  return { ok: true, remito };
}

// Decide un ítem (SKU) ya en Oficina: apto vuelve al stock, no apto es baja.
// Cuando todos los ítems están decididos, cierra la devolución.
async function decidirItemDevolucion(db: DB, p: Record<string, unknown>, actor: string) {
  const itemId = String(p.item_id);
  const apta = Boolean(p.apta);
  const { data: it } = await db.from("devolucion_items").select("*, devoluciones(id)").eq("id", itemId).single();
  if (!it) throw new Error("ítem no encontrado");
  const devId = it.devolucion_id;
  const { data: ofi } = await db.from("depositos").select("id").eq("codigo", "OFI").single();

  if (apta) {
    // Queda como stock. Si se elige otro depósito, se mueve desde Oficina
    // (traslado = dos ajustes en Contabilium, igual que un movimiento).
    const destino = (p.deposito_destino_id as string) ?? null;
    if (destino && destino !== ofi!.id && it.producto_id) {
      await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: ofi!.id, p_delta: -it.cantidad });
      await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: destino, p_delta: it.cantidad });
      await enqueueAjuste(db, it.producto_id, ofi!.id, -it.cantidad, "Devolución apta: reubicación desde Oficina");
      await enqueueAjuste(db, it.producto_id, destino, it.cantidad, "Devolución apta: reubicación a destino");
    }
    await db.from("devolucion_items").update({ apta: true, destino_no_apta: null, valor_perdida: null, decidido_por: actor, decidido_at: new Date().toISOString() }).eq("id", itemId);
  } else {
    // Baja del stock (sale de Oficina) + pérdida valorizada al costo.
    let perdida: number | null = (p.valor_perdida as number) ?? null;
    if (it.producto_id) {
      await db.rpc("ajustar_stock_espejo", { p_producto: it.producto_id, p_deposito: ofi!.id, p_delta: -it.cantidad });
      await enqueueAjuste(db, it.producto_id, ofi!.id, -it.cantidad, "Baja por devolución no apta");
      if (perdida == null) {
        const { data: prod } = await db.from("productos").select("costo").eq("id", it.producto_id).single();
        if (prod?.costo != null) perdida = Number(prod.costo) * Number(it.cantidad);
      }
    }
    await db.from("devolucion_items").update({ apta: false, destino_no_apta: (p.destino_no_apta as string) ?? "tirar", valor_perdida: perdida, decidido_por: actor, decidido_at: new Date().toISOString() }).eq("id", itemId);
  }

  // ¿Ya están todos los ítems decididos? Cerrar la cabecera.
  const { data: all } = await db.from("devolucion_items").select("apta, valor_perdida").eq("devolucion_id", devId);
  const pendientes = (all ?? []).filter((x) => x.apta === null).length;
  if (pendientes === 0) {
    const aptos = (all ?? []).filter((x) => x.apta === true).length;
    const noAptos = (all ?? []).filter((x) => x.apta === false).length;
    const estado = aptos && noAptos ? "parcial" : aptos ? "apta" : "no_apta";
    const perdidaTotal = (all ?? []).reduce((a, x) => a + (Number(x.valor_perdida) || 0), 0);
    await db.from("devoluciones").update({ estado, valor_perdida: perdidaTotal || null, decidido_por: actor }).eq("id", devId);
    await audit(db, "devolucion", devId, estado, { aptos, noAptos }, actor);
  }
  return { ok: true };
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
