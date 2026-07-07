// ============================================================================
// contabilium-worker — ÚNICO escritor hacia Contabilium
// ----------------------------------------------------------------------------
// Drena la cola cb_queue de a una acción por vez, con pausa entre llamadas para
// respetar el límite de 25 req / 10 s. Ante 429 (rate limit) corta la tanda y
// deja los pendientes para la próxima corrida (backoff natural). Se invoca por
// cron cada 1-2 minutos, o a demanda.
// ============================================================================
import { preflight, json } from "../_shared/cors.ts";
import { serviceClient, audit } from "../_shared/supabase.ts";
import {
  ajustarStock,
  notaCreditoRapida,
  RateLimitError,
} from "../_shared/contabilium.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_POR_TANDA = 15;   // cómodo bajo 25/10s con la pausa de abajo
const PAUSA_MS = 500;
const MAX_INTENTOS = 5;

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  const db = serviceClient();
  let procesados = 0, ok = 0, errores = 0;

  const { data: pendientes } = await db
    .from("cb_queue")
    .select("*")
    .in("estado", ["pendiente", "error"])
    .lt("intentos", MAX_INTENTOS)
    .order("created_at", { ascending: true })
    .limit(MAX_POR_TANDA);

  for (const item of pendientes ?? []) {
    procesados++;
    await db.from("cb_queue").update({ estado: "procesando" }).eq("id", item.id);
    try {
      await ejecutar(db, item);
      await db.from("cb_queue").update({
        estado: "ok",
        procesado_at: new Date().toISOString(),
        ultimo_error: null,
      }).eq("id", item.id);
      ok++;
    } catch (e) {
      errores++;
      const esRate = e instanceof RateLimitError;
      await db.from("cb_queue").update({
        estado: "error",
        intentos: (item.intentos ?? 0) + 1,
        ultimo_error: String(e),
      }).eq("id", item.id);
      await audit(db, "cb_queue", item.id, "error", { error: String(e) }, "worker");
      if (esRate) break; // frenar la tanda; reintenta en la próxima corrida
    }
    await sleep(PAUSA_MS);
  }

  return json({ ok: true, procesados, exitosos: ok, errores });
});

// ---- Ejecuta una acción de la cola contra Contabilium --------------------
async function ejecutar(
  db: ReturnType<typeof serviceClient>,
  item: Record<string, unknown>,
): Promise<void> {
  const accion = String(item.accion);
  const p = (item.payload ?? {}) as Record<string, unknown>;

  switch (accion) {
    case "ajuste_stock": {
      // { cb_producto_id, cb_deposito_id, delta, motivo }
      await ajustarStock(
        String(p.cb_producto_id),
        String(p.cb_deposito_id),
        Number(p.delta),
        String(p.motivo ?? "Centro de Stock"),
      );
      return;
    }
    case "nota_credito": {
      // { cb_comprobante_id, devolucion_id }
      const r = await notaCreditoRapida(String(p.cb_comprobante_id));
      if (p.devolucion_id) {
        await db.from("devoluciones")
          .update({ nota_credito_cb_id: r.id ?? "emitida" })
          .eq("id", String(p.devolucion_id));
      }
      return;
    }
    default:
      throw new Error(`Acción de cola desconocida: ${accion}`);
  }
}
