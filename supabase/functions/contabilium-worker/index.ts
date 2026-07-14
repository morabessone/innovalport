// ============================================================================
// contabilium-worker — ÚNICO escritor hacia Contabilium
// ----------------------------------------------------------------------------
// Drena la cola cb_queue de a una acción por vez, con pausa entre llamadas para
// respetar el límite de 25 req / 10 s. Ante 429 (rate limit) corta la tanda y
// deja los pendientes para la próxima corrida (backoff natural). Se invoca por
// cron cada 1-2 minutos, o a demanda.
//
// MODO SEGURO (dry-run) — por defecto ENCENDIDO:
//   Con CB_DRY_RUN != "0", el worker NO toca Contabilium. Para cada acción
//   calcula exactamente el request que enviaría (endpoint + payload) y lo
//   guarda en cb_queue.simulacion, con estado 'simulado'. Así se puede revisar
//   y aprobar la escritura antes de habilitar el modo real (CB_DRY_RUN=0).
// ============================================================================
import { preflight, json } from "../_shared/cors.ts";
import { serviceClient, audit } from "../_shared/supabase.ts";
import {
  planAjustarStock,
  planEstadoProducto,
  planNotaCredito,
  ejecutarPlan,
  RateLimitError,
  type PlanRequest,
} from "../_shared/contabilium.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_POR_TANDA = 15;   // cómodo bajo 25/10s con la pausa de abajo
const PAUSA_MS = 500;
const MAX_INTENTOS = 5;
const DRY_RUN = (Deno.env.get("CB_DRY_RUN") ?? "1") !== "0";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  const db = serviceClient();
  let procesados = 0, ok = 0, simulados = 0, errores = 0;

  const { data: pendientes } = await db
    .from("cb_queue")
    .select("*")
    .in("estado", ["pendiente", "error"])
    .lt("intentos", MAX_INTENTOS)
    .order("created_at", { ascending: true })
    .limit(MAX_POR_TANDA);

  for (const item of pendientes ?? []) {
    procesados++;

    let plan: PlanRequest;
    try {
      plan = planDeItem(item);
    } catch (e) {
      errores++;
      await db.from("cb_queue").update({
        estado: "error",
        intentos: (item.intentos ?? 0) + 1,
        ultimo_error: String(e),
      }).eq("id", item.id);
      continue;
    }

    // --- Modo seguro: registrar el plan y NO tocar Contabilium ---
    if (DRY_RUN) {
      await db.from("cb_queue").update({
        estado: "simulado",
        simulacion: plan as unknown as Record<string, unknown>,
        simulado_at: new Date().toISOString(),
        ultimo_error: null,
      }).eq("id", item.id);
      await audit(db, "cb_queue", item.id, "simulado", { plan }, "worker");
      simulados++;
      continue;
    }

    // --- Modo real: ejecutar el plan contra Contabilium ---
    await db.from("cb_queue").update({ estado: "procesando" }).eq("id", item.id);
    try {
      const resultado = await ejecutarPlan(plan);
      await posProceso(db, item, resultado);
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

  return json({ ok: true, dry_run: DRY_RUN, procesados, exitosos: ok, simulados, errores });
});

// ---- Traduce una fila de la cola a un plan de request (sin ejecutarlo) ----
function planDeItem(item: Record<string, unknown>): PlanRequest {
  const accion = String(item.accion);
  const p = (item.payload ?? {}) as Record<string, unknown>;
  switch (accion) {
    case "ajuste_stock":
      // { cb_producto_id, cb_deposito_id, delta, motivo }
      return planAjustarStock(
        String(p.cb_producto_id),
        String(p.cb_deposito_id),
        Number(p.delta),
        String(p.motivo ?? "Centro de Stock"),
      );
    case "estado_producto":
      // { cb_producto_id, sku, activo }
      return planEstadoProducto(
        (p.cb_producto_id as string) ?? null,
        (p.sku as string) ?? null,
        Boolean(p.activo),
      );
    case "nota_credito":
      // { cb_comprobante_id, devolucion_id }
      return planNotaCredito(String(p.cb_comprobante_id));
    default:
      throw new Error(`Acción de cola desconocida: ${accion}`);
  }
}

// ---- Efectos posteriores a una escritura real exitosa --------------------
async function posProceso(
  db: ReturnType<typeof serviceClient>,
  item: Record<string, unknown>,
  resultado: unknown,
): Promise<void> {
  if (String(item.accion) === "nota_credito") {
    const p = (item.payload ?? {}) as Record<string, unknown>;
    const r = (resultado ?? {}) as { id?: string };
    if (p.devolucion_id) {
      await db.from("devoluciones")
        .update({ nota_credito_cb_id: r.id ?? "emitida" })
        .eq("id", String(p.devolucion_id));
    }
  }
}
