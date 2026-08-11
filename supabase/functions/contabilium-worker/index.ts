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
//
// Self-contained (sin imports de _shared) para poder desplegar por MCP. Los
// contratos de Contabilium (endpoints + método) están CONFIRMADOS por sonda con
// id inexistente (ver docs). El espejo repo de esos contratos vive en
// _shared/contabilium.ts; este archivo los inlinea 1:1.
// ============================================================================
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ---- inlined _shared/cors.ts ----
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

// ---- inlined _shared/supabase.ts ----
function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function audit(db: SupabaseClient, entidad: string, entidad_id: string | null, accion: string, detalle: unknown, actor = "sistema"): Promise<void> {
  try { await db.from("auditoria").insert({ entidad, entidad_id, accion, detalle, actor }); } catch (_e) { /* no frenar */ }
}

// ---- inlined _shared/contabilium.ts (escritura, contratos confirmados) ----
const BASE = Deno.env.get("CONTABILIUM_BASE_URL") ?? "https://rest.contabilium.com";
const EP = {
  token: "/token",
  ajusteStock: "/api/conceptos/ajustarStock",  // GET ?id=&idDeposito=&cantidad=
  ncRapida: Deno.env.get("CB_EP_NC_RAPIDA") ?? "/api/comprobantes/anularrapido", // [VERIFICAR]
};

// Credenciales: SIEMPRE de canal_config (fuente única, igual que las demás
// funciones). Contabilium OAuth2 client_credentials: client_id = email de la
// cuenta, client_secret = API Key. El handler setea `cfgDb` antes de escribir.
let cfgDb: SupabaseClient | null = null;
async function getToken(): Promise<string> {
  if (!cfgDb) throw new Error("worker: falta el cliente de base para leer canal_config");
  const { data: cfg } = await cfgDb.from("canal_config").select("*").eq("tipo", "contabilium").single();
  if (!cfg?.client_id || !cfg?.client_secret) throw new Error("Faltan credenciales de Contabilium en canal_config (client_id = email, client_secret = API Key)");
  const exp = cfg.expires_at ? new Date(cfg.expires_at).getTime() : 0;
  if (cfg.access_token && exp > Date.now() + 60_000) return cfg.access_token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.client_id, client_secret: cfg.client_secret });
  const res = await fetch(BASE + EP.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`Contabilium token ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const token = data.access_token ?? data.token;
  if (!token) throw new Error("Contabilium no devolvió access_token");
  const ttl = Number(data.expires_in ?? 3600);
  await cfgDb.from("canal_config").update({ access_token: token, expires_at: new Date(Date.now() + ttl * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("tipo", "contabilium");
  return token;
}

class RateLimitError extends Error {}
async function call(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await getToken();
  const res = await fetch(BASE + path, { ...init, headers: { ...(init.headers ?? {}), "Authorization": `Bearer ${token}`, "Accept": "application/json" } });
  if (res.status === 401 && retry) {
    // token vencido/inválido: limpiarlo en canal_config y reintentar una vez.
    if (cfgDb) await cfgDb.from("canal_config").update({ access_token: null, expires_at: null }).eq("tipo", "contabilium");
    return call(path, init, false);
  }
  if (res.status === 429) throw new RateLimitError("Contabilium 429: rate limit alcanzado");
  return res;
}
async function callJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await call(path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`Contabilium ${res.status} ${path}: ${text}`);
  return text ? JSON.parse(text) as T : ({} as T);
}

interface PlanRequest { endpoint: string; method: string; base: string; body: Record<string, unknown>; descripcion: string; }

// GET /api/conceptos/ajustarStock?id={concepto}&idDeposito={dep}&cantidad={n}
function planAjustarStock(cbProductoId: string, cbDepositoId: string, cantidad: number, motivo: string): PlanRequest {
  const qs = `?id=${encodeURIComponent(cbProductoId)}&idDeposito=${encodeURIComponent(cbDepositoId)}&cantidad=${cantidad}`;
  return { base: BASE, endpoint: EP.ajusteStock + qs, method: "GET", body: {},
    descripcion: `Ajustar stock (${cantidad}) en depósito ${cbDepositoId} del concepto ${cbProductoId} — ${motivo}` };
}

// GET /api/conceptos/darDeAlta|darDeBaja?id={concepto}
function planEstadoProducto(cbProductoId: string | null, sku: string | null, activo: boolean): PlanRequest {
  const accion = activo ? "darDeAlta" : "darDeBaja";
  return { base: BASE, endpoint: `/api/conceptos/${accion}?id=${encodeURIComponent(cbProductoId ?? "")}`, method: "GET", body: {},
    descripcion: `${activo ? "Reactivar" : "Dar de baja"} el concepto ${sku ?? cbProductoId ?? "(sin id CB)"}` };
}

// POST /api/conceptos — alta COMPLETA de un producto (concepto).
interface NuevoProductoCB {
  sku: string; nombre: string; costo?: number; precio?: number; iva?: number;
  codigoBarras?: string; codigoProveedor?: string; idProveedorCB?: number | null;
  descripcion?: string; observaciones?: string; stockMinimo?: number; idRubro?: number; idMoneda?: number;
}
function planCrearProducto(p: NuevoProductoCB): PlanRequest {
  const iva = p.iva ?? 21;
  const precio = Number(p.precio ?? 0) || 0;
  const precioFinal = precio ? Number((precio * (1 + iva / 100)).toFixed(2)) : 0;
  return {
    base: BASE, endpoint: "/api/conceptos", method: "POST",
    body: {
      Codigo: p.sku, Nombre: p.nombre, Tipo: "Producto", Estado: "Activo",
      Descripcion: p.descripcion ?? "", Observaciones: p.observaciones ?? "",
      CodigoBarras: p.codigoBarras ?? "", CodigoProveedor: p.codigoProveedor ?? "",
      CostoInterno: Number(p.costo ?? 0) || 0, Precio: precio, PrecioFinal: precioFinal, Iva: iva,
      StockMinimo: Math.round(Number(p.stockMinimo ?? 0)) || 0,
      IDProveedor: p.idProveedorCB ?? null, IdRubro: p.idRubro ?? 299062, IDMoneda: p.idMoneda ?? 86287,
      SincronizaStock: false, SincronizaPrecio: false, AplicaRG5329: false,
    },
    descripcion: `Crear producto ${p.sku} (${p.nombre}) en Contabilium`,
  };
}

function planNotaCredito(cbComprobanteId: string): PlanRequest {
  return { base: BASE, endpoint: EP.ncRapida, method: "POST", body: { idComprobante: cbComprobanteId },
    descripcion: `Emitir nota de crédito del comprobante ${cbComprobanteId}` };
}

async function ejecutarPlan(plan: PlanRequest): Promise<unknown> {
  const init: RequestInit = { method: plan.method, headers: { "Content-Type": "application/json" } };
  // GET/HEAD no llevan body (ajustarStock/darDeBaja/darDeAlta van por query-string).
  if (plan.method !== "GET" && plan.method !== "HEAD") init.body = JSON.stringify(plan.body);
  return callJson(plan.endpoint, init);
}

// ============================================================================
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_POR_TANDA = 15;
const PAUSA_MS = 500;
const MAX_INTENTOS = 5;
const DRY_RUN = (Deno.env.get("CB_DRY_RUN") ?? "1") !== "0";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  const db = serviceClient();
  cfgDb = db;  // habilita getToken() para leer credenciales de canal_config
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
      await db.from("cb_queue").update({ estado: "error", intentos: (item.intentos ?? 0) + 1, ultimo_error: String(e) }).eq("id", item.id);
      continue;
    }

    if (DRY_RUN) {
      await db.from("cb_queue").update({
        estado: "simulado",
        simulacion: plan as unknown as Record<string, unknown>,
        simulado_at: new Date().toISOString(),
        ultimo_error: null,
      }).eq("id", item.id);
      await audit(db, "cb_queue", String(item.id), "simulado", { plan }, "worker");
      simulados++;
      continue;
    }

    await db.from("cb_queue").update({ estado: "procesando" }).eq("id", item.id);
    try {
      const resultado = await ejecutarPlan(plan);
      await posProceso(db, item, resultado);
      await db.from("cb_queue").update({ estado: "ok", procesado_at: new Date().toISOString(), ultimo_error: null }).eq("id", item.id);
      ok++;
    } catch (e) {
      errores++;
      const esRate = e instanceof RateLimitError;
      await db.from("cb_queue").update({ estado: "error", intentos: (item.intentos ?? 0) + 1, ultimo_error: String(e) }).eq("id", item.id);
      await audit(db, "cb_queue", String(item.id), "error", { error: String(e) }, "worker");
      if (esRate) break;
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
      return planAjustarStock(String(p.cb_producto_id), String(p.cb_deposito_id), Number(p.delta), String(p.motivo ?? "Centro de Stock"));
    case "estado_producto":
      return planEstadoProducto((p.cb_producto_id as string) ?? null, (p.sku as string) ?? null, Boolean(p.activo));
    case "crear_producto":
      return planCrearProducto({
        sku: String(p.sku), nombre: String(p.nombre),
        costo: p.costo != null ? Number(p.costo) : undefined,
        precio: p.precio != null ? Number(p.precio) : undefined,
        iva: p.iva != null ? Number(p.iva) : undefined,
        codigoBarras: (p.codigo_barras as string) ?? undefined,
        codigoProveedor: (p.codigo_proveedor as string) ?? undefined,
        idProveedorCB: p.id_proveedor_cb != null ? Number(p.id_proveedor_cb) : null,
        descripcion: (p.descripcion as string) ?? undefined,
        stockMinimo: p.stock_minimo != null ? Number(p.stock_minimo) : undefined,
      });
    case "nota_credito":
      return planNotaCredito(String(p.cb_comprobante_id));
    default:
      throw new Error(`Acción de cola desconocida: ${accion}`);
  }
}

// ---- Efectos posteriores a una escritura real exitosa --------------------
async function posProceso(db: ReturnType<typeof serviceClient>, item: Record<string, unknown>, resultado: unknown): Promise<void> {
  const accion = String(item.accion);
  const p = (item.payload ?? {}) as Record<string, unknown>;
  if (accion === "nota_credito" && p.devolucion_id) {
    const r = (resultado ?? {}) as { id?: string };
    await db.from("devoluciones").update({ nota_credito_cb_id: r.id ?? "emitida" }).eq("id", String(p.devolucion_id));
  }
  // Producto creado en Contabilium: guardar su Id y marcar como sincronizado.
  if (accion === "crear_producto" && p.producto_id) {
    const r = (resultado ?? {}) as { Id?: number | string; id?: number | string };
    const cbId = r.Id ?? r.id ?? null;
    if (cbId != null) {
      await db.from("productos").update({ cb_producto_id: String(cbId), cb_pendiente: false }).eq("id", String(p.producto_id));
    }
  }
}
