#!/usr/bin/env node
// ============================================================================
// test-contabilium.mjs — sondeo de SOLO LECTURA de la API de Contabilium
// ----------------------------------------------------------------------------
// Hace tres cosas, sin escribir NADA:
//   1) valida que las credenciales generan un token,
//   2) sondea endpoints candidatos y te dice cuáles responden,
//   3) lista tus depósitos (con IDs) y algunos productos con su stock.
//
// Uso:
//   cp .env.example .env   # completá CONTABILIUM_CLIENT_ID (email) y _SECRET (API Key)
//   node --env-file=.env scripts/test-contabilium.mjs
// ============================================================================

const BASE = process.env.CONTABILIUM_BASE_URL || "https://rest.contabilium.com";
const CLIENT_ID = process.env.CONTABILIUM_CLIENT_ID;
const CLIENT_SECRET = process.env.CONTABILIUM_CLIENT_SECRET;

const c = {
  reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m",
  yellow: "\x1b[33m", dim: "\x1b[2m", bold: "\x1b[1m",
};
const ok = (s) => console.log(`${c.green}✓${c.reset} ${s}`);
const bad = (s) => console.log(`${c.red}✗${c.reset} ${s}`);
const info = (s) => console.log(`${c.dim}  ${s}${c.reset}`);

if (!CLIENT_ID || !CLIENT_SECRET) {
  bad("Faltan CONTABILIUM_CLIENT_ID y/o CONTABILIUM_CLIENT_SECRET.");
  info("Copiá .env.example a .env y completá el email de la cuenta y la API Key.");
  process.exit(1);
}

async function getToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(BASE + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = await res.json();
  const token = data.access_token || data.token;
  if (!token) throw new Error("respuesta sin access_token: " + JSON.stringify(data));
  return token;
}

async function probe(token, path) {
  try {
    const res = await fetch(BASE + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    return { path, status: res.status, sample: (await res.text()).slice(0, 160) };
  } catch (e) {
    return { path, status: 0, sample: String(e) };
  }
}

console.log(`\n${c.bold}Sondeo de Contabilium${c.reset}  ${c.dim}(${BASE})${c.reset}\n`);

let token;
try {
  token = await getToken();
  ok("Token obtenido — las credenciales funcionan.");
} catch (e) {
  bad("No se pudo obtener token: " + e.message);
  info("Verificá que el plan sea Full o superior y que la API Key sea correcta.");
  process.exit(1);
}

// Endpoints (el de productos/conceptos está CONFIRMADO contra la API real;
// el resto quedan como sondeo para futuras integraciones).
const candidatos = [
  "/api/conceptos/search?filtro=&pageSize=5&page=1", // CONFIRMADO: productos ("conceptos")
  "/api/conceptos/18509830",                          // detalle de un concepto por Id
  "/api/comprobantes/search?fechaDesde=2025-01-01&pageSize=5",
];

console.log(`\n${c.bold}Endpoints${c.reset}`);
const resultados = [];
for (const path of candidatos) {
  const r = await probe(token, path);
  resultados.push(r);
  const marca = r.status >= 200 && r.status < 300 ? `${c.green}${r.status}${c.reset}`
    : r.status === 404 ? `${c.yellow}404${c.reset}` : `${c.red}${r.status}${c.reset}`;
  console.log(`  ${marca}  ${path}`);
  if (r.status >= 200 && r.status < 300) info(r.sample);
  await new Promise((r) => setTimeout(r, 500)); // respeta el rate limit
}

console.log(
  `\n${c.dim}Pasá este output al equipo de desarrollo: confirma qué rutas existen ` +
  `y con qué forma, para fijar los endpoints [VERIFICAR] del worker.${c.reset}\n`,
);
