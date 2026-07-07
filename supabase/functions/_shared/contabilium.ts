// ============================================================================
// Cliente de la API de Contabilium
// ----------------------------------------------------------------------------
// Hallazgos de la investigación (ver docs/soluciones/arquitectura-tecnica-stock.md):
//   * Base URL Argentina: https://rest.contabilium.com
//   * Auth: Bearer token con client_id (email de la cuenta) + client_secret (API Key)
//   * Requiere plan Full o superior. No hay ambiente de pruebas (todo producción).
//   * Rate limit: 25 peticiones / 10 s por IP; si se excede bloquea ~1 min.
//     -> Por eso SOLO el worker escribe, procesando de a uno con pausa.
//
// Los endpoints marcados [VERIFICAR] no pudieron confirmarse sin la colección
// Postman completa. Se dejan como variables de entorno para ajustarlos sin
// tocar código una vez que scripts/test-contabilium.mjs los confirme o llegue
// la respuesta de api@contabilium.com. Cada uno tiene un default razonable.
// ============================================================================

const BASE = Deno.env.get("CONTABILIUM_BASE_URL") ?? "https://rest.contabilium.com";
const CLIENT_ID = Deno.env.get("CONTABILIUM_CLIENT_ID") ?? "";     // email
const CLIENT_SECRET = Deno.env.get("CONTABILIUM_CLIENT_SECRET") ?? ""; // API Key

// Rutas configurables (con defaults). [VERIFICAR] los que llevan comentario.
const EP = {
  token: Deno.env.get("CB_EP_TOKEN") ?? "/token",
  productos: Deno.env.get("CB_EP_PRODUCTOS") ?? "/api/productos",          // [VERIFICAR] paginado
  productoStock: Deno.env.get("CB_EP_PRODUCTO_STOCK") ?? "/api/productos/stock", // [VERIFICAR]
  ajusteStock: Deno.env.get("CB_EP_AJUSTE_STOCK") ?? "/api/stock/ajuste",  // [VERIFICAR]
  remito: Deno.env.get("CB_EP_REMITO") ?? "/api/comprobantes",            // [VERIFICAR] tipo remito
  ncRapida: Deno.env.get("CB_EP_NC_RAPIDA") ?? "/api/comprobantes/anularrapido", // [VERIFICAR]
};

let cachedToken: { value: string; exp: number } | null = null;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.exp > now + 30_000) return cachedToken.value;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "Faltan CONTABILIUM_CLIENT_ID / CONTABILIUM_CLIENT_SECRET (email + API Key)",
    );
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(BASE + EP.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Contabilium token ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const token = data.access_token ?? data.token;
  const expiresIn = Number(data.expires_in ?? 3600);
  if (!token) throw new Error("Contabilium no devolvió access_token");
  cachedToken = { value: token, exp: now + expiresIn * 1000 };
  return token;
}

export class RateLimitError extends Error {}

// Llamada base con manejo de 401 (refresca token) y 429 (rate limit).
async function call(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<Response> {
  const token = await getToken();
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
    },
  });
  if (res.status === 401 && retry) {
    cachedToken = null;
    return call(path, init, false);
  }
  if (res.status === 429) {
    throw new RateLimitError("Contabilium 429: rate limit alcanzado");
  }
  return res;
}

async function callJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await call(path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`Contabilium ${res.status} ${path}: ${text}`);
  return text ? JSON.parse(text) as T : ({} as T);
}

// ---- Lectura (usada por stock-sync) --------------------------------------

export interface CbProducto {
  id: string;
  sku: string;
  nombre: string;
  costo?: number;
  precio?: number;
}

export async function listarProductos(page = 1, pageSize = 100): Promise<CbProducto[]> {
  const data = await callJson<Record<string, unknown>>(
    `${EP.productos}?page=${page}&pageSize=${pageSize}`,
  );
  // Contabilium suele envolver en { Items: [...] } o devolver un array plano.
  const items = (data.Items ?? data.items ?? data) as Record<string, unknown>[];
  const arr = Array.isArray(items) ? items : [];
  return arr.map((p) => ({
    id: String(p.Id ?? p.id ?? ""),
    sku: String(p.Codigo ?? p.sku ?? p.SKU ?? ""),
    nombre: String(p.Nombre ?? p.nombre ?? ""),
    costo: num(p.CostoInterno ?? p.Costo ?? p.costo),
    precio: num(p.PrecioFinal ?? p.Precio ?? p.precio),
  }));
}

// Stock por depósito de un producto. Estructura [VERIFICAR].
export async function stockDeProducto(
  cbProductoId: string,
): Promise<{ cbDepositoId: string; cantidad: number }[]> {
  const data = await callJson<Record<string, unknown>>(
    `${EP.productoStock}?idProducto=${encodeURIComponent(cbProductoId)}`,
  );
  const items = (data.Items ?? data.items ?? data) as Record<string, unknown>[];
  const arr = Array.isArray(items) ? items : [];
  return arr.map((s) => ({
    cbDepositoId: String(s.IdDeposito ?? s.idDeposito ?? s.DepositoId ?? ""),
    cantidad: Number(s.Stock ?? s.stock ?? s.Cantidad ?? 0),
  }));
}

// ---- Escritura (usada SOLO por contabilium-worker) -----------------------

// Ajuste de stock en un depósito (delta puede ser + o -). [VERIFICAR]
export async function ajustarStock(
  cbProductoId: string,
  cbDepositoId: string,
  delta: number,
  motivo: string,
): Promise<unknown> {
  return callJson(EP.ajusteStock, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idProducto: cbProductoId,
      idDeposito: cbDepositoId,
      cantidad: delta,
      motivo,
    }),
  });
}

// Nota de crédito rápida a partir de un comprobante existente. [VERIFICAR]
export async function notaCreditoRapida(
  cbComprobanteId: string,
): Promise<{ id?: string }> {
  return callJson(EP.ncRapida, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idComprobante: cbComprobanteId }),
  });
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export const contabiliumConfig = { BASE, EP, tieneCredenciales: !!(CLIENT_ID && CLIENT_SECRET) };
