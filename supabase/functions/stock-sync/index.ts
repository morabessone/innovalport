// ============================================================================
// stock-sync — Fase 1 (solo lectura, riesgo cero)
// ----------------------------------------------------------------------------
// Trae el catálogo y el stock por depósito desde Contabilium hacia el espejo
// (tablas productos / stock). NO escribe nada en Contabilium.
// Pensada para correr por cron (cada N minutos) o a demanda desde el panel.
// ============================================================================
import { preflight, json } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { listarProductos, stockDeProducto } from "../_shared/contabilium.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  const db = serviceClient();
  const detalle: Record<string, unknown> = { catalogo: 0, stock: 0, errores: [] };

  try {
    // 1) Depósitos: mapa cb_deposito_id -> deposito_id
    const { data: deps } = await db.from("depositos").select("id, cb_deposito_id");
    const depMap = new Map<string, string>();
    for (const d of deps ?? []) {
      if (d.cb_deposito_id) depMap.set(String(d.cb_deposito_id), d.id);
    }

    // 2) Catálogo (paginado)
    const productosCb: { id: string; sku: string; nombre: string; costo?: number; precio?: number }[] = [];
    for (let page = 1; page <= 50; page++) {
      const chunk = await listarProductos(page, 100);
      if (chunk.length === 0) break;
      productosCb.push(...chunk);
      if (chunk.length < 100) break;
      await sleep(450); // respeta el rate limit
    }

    // Upsert por SKU (el SKU es la clave estable entre Contabilium y el espejo)
    const rows = productosCb
      .filter((p) => p.sku)
      .map((p) => ({
        sku: p.sku,
        nombre: p.nombre,
        cb_producto_id: p.id,
        costo: p.costo ?? null,
        precio: p.precio ?? null,
        updated_at: new Date().toISOString(),
      }));
    if (rows.length) {
      const { error } = await db.from("productos").upsert(rows, { onConflict: "sku" });
      if (error) throw error;
    }
    detalle.catalogo = rows.length;

    // 3) Stock por depósito (una llamada por producto, con pausa)
    const { data: prods } = await db
      .from("productos")
      .select("id, cb_producto_id")
      .not("cb_producto_id", "is", null);

    let stockRows = 0;
    for (const p of prods ?? []) {
      try {
        const st = await stockDeProducto(String(p.cb_producto_id));
        for (const s of st) {
          const depId = depMap.get(s.cbDepositoId);
          if (!depId) continue; // depósito de Contabilium aún no mapeado
          await db.from("stock").upsert(
            {
              producto_id: p.id,
              deposito_id: depId,
              cantidad: s.cantidad,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "producto_id,deposito_id" },
          );
          stockRows++;
        }
      } catch (e) {
        (detalle.errores as string[]).push(`stock ${p.cb_producto_id}: ${String(e)}`);
      }
      await sleep(450);
    }
    detalle.stock = stockRows;

    await db.from("sync_estado").upsert({
      job: "catalogo",
      ultima_ok: new Date().toISOString(),
      detalle,
      updated_at: new Date().toISOString(),
    });

    return json({ ok: true, ...detalle });
  } catch (e) {
    return json({ ok: false, error: String(e), detalle }, 500);
  }
});
