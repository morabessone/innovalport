# Arquitectura técnica — Solución de Stock ("Centro de Stock")

Registro de la sesión de diseño inicial (claude.ai, previa a este repo) donde se investigaron las APIs, se tomaron las decisiones de arquitectura y se diseñó el sistema. **Importante: el código descrito acá se diseñó pero nunca llegó a este repositorio** (ver §6). Este documento preserva la sustancia para poder reconstruirlo.

Complementa a [`./stock.md`](./stock.md): aquel es el diagnóstico operativo (as-is → to-be) construido desde el relevamiento; este es la arquitectura técnica construida desde la investigación de las APIs.

## 1. Hallazgos de investigación de APIs

### Contabilium (la pieza clave)
- API REST, base URL **`https://rest.contabilium.com`** (Argentina).
- Autenticación: **Bearer Token** generado con `client_id` (email de la cuenta) + `client_secret` (API Key).
- Requiere **plan Full o superior**. ✅ Confirmado por Martín que la cuenta es Full y que ya tiene la API Key.
- **No tiene ambiente de pruebas** — opera solo en producción. Todo test es sobre datos reales.
- **Rate limit: 25 peticiones cada 10 segundos por IP.** Si se excede, bloquea ~1 minuto — y el bloqueo afecta incluso la emisión de facturas desde esa misma red. → **Implicación de diseño: el sistema debe centralizar y encolar todas las llamadas a Contabilium en una única cola con throttle.**
- **Notas de crédito (resuelve el "punto a chequear" de devoluciones):** existen endpoints `AnularComprobanteRápido` (crea NC a partir de un comprobante existente, copiando su info) y `AnularComprobante Manual/Parcial` (para devoluciones parciales).
- Credenciales: Mi Cuenta → Configuración → API → Credenciales.

### Integraciones nativas de Contabilium
- Contabilium **ya sincroniza stock y facturación con Mercado Libre y Tienda Nube** de forma nativa.
- Permite elegir **qué depósito sincroniza el stock hacia cada canal** (si se deja vacío, publica la suma de todos los depósitos). → Explica el problema de sincronización parcial que reportó Tomás; hay que auditar esta config.
- Tiene la opción **"Deshabilitar reposición de stock en devoluciones"**, que deja las devoluciones en estado **"A revisar"** para gestión manual. → Ese estado "A revisar" es el gancho exacto que necesita nuestro pipeline de devoluciones (apto/no apto).

## 2. Decisión de arquitectura #1 (la más importante)

> **Contabilium queda como única fuente de verdad del stock**, y sus integraciones nativas con ML y TN siguen empujando el stock a esos canales. **No se reconstruye eso** — sería duplicar algo que ya funciona e introducir una segunda fuente de verdad.

Lo que se construye es **una capa por encima de Contabilium** que:
1. Elimina la carga manual ("la paja" de cargar todo en Contabilium a mano).
2. Le agrega lo que le falta: OCR de facturas, remitos de movimiento con un tap, y el pipeline de devoluciones con apto/no apto + NC automática.

> Nota: esto **resuelve la Decisión abierta #1 de [`stock.md`](./stock.md) §8** (¿Contabilium mismo o capa propia?). La respuesta es: Contabilium como fuente de verdad + capa propia de operación encima, no una segunda fuente de verdad.

## 3. Stack técnico

- **Backend / datos:** Supabase (free tier, región São Paulo). Contiene: cola de llamadas hacia Contabilium, pipeline de devoluciones, remitos, aliases de SKU que el OCR va aprendiendo, pérdidas valorizadas, log de auditoría.
- **Edge Functions (2):**
  - `contabilium-worker` — worker con token caching, throttle y backoff ante error 429 (respeta el rate limit de 25 req/10s).
  - `ocr-ingreso` — OCR de facturas con Claude + matching de SKUs (aprende aliases).
- **Frontend:** panel React ("Centro de Stock"), el lugar único y consolidado. Corre en modo demo sin credenciales (para mostrar al equipo) y con datos reales al conectar Supabase.

## 4. El panel "Centro de Stock" — 4 flujos

1. **Panel**: stock consolidado por depósito + alertas de reposición.
2. **Ingreso por foto de factura**: OCR que matchea SKUs con nivel de confianza; las líneas dudosas quedan marcadas (amarillo) para confirmar a mano. Reemplaza la carga manual en Contabilium.
3. **Movimiento entre depósitos**: el remito se genera solo (con numeración + QR), con un tap. Reemplaza la planilla de Excel + WhatsApp de hoy.
4. **Devoluciones** (el pipeline exacto del relevamiento): cargada → remito de retiro automático → en oficina → **apta** (alta sin compra + NC automática) / **no apta** (baja de stock + pérdida valorizada registrada).

Los puntos donde en producción se llama a las APIs están marcados con `[API]` en el código.

## 5. Artefactos que se diseñaron en la sesión previa

| Artefacto | Qué es | Estado en este repo |
|---|---|---|
| `centro-de-stock.jsx` | Panel React funcional (modo demo) con los 4 flujos | ❌ No está |
| `arquitectura-centro-stock.md` | Documento de arquitectura + hallazgos de investigación | ❌ No está (su contenido se preserva acá) |
| `schema.sql` | Base completa en Supabase (cola, devoluciones, remitos, aliases SKU, pérdidas, auditoría) | ❌ No está |
| `seed.sql` | Datos semilla | ❌ No está |
| `contabilium-worker.ts` | Edge Function worker (token caching, throttle, backoff 429) | ❌ No está |
| `ocr-ingreso.ts` | Edge Function OCR de facturas (Claude + matching SKU) | ❌ No está |
| `scripts/test-contabilium.mjs` | Script de test de solo lectura (valida token, sondea endpoints, lista depósitos/productos) | ❌ No está |
| `README`, `.env.example` | Instrucciones de puesta en marcha | ❌ No está |

## 6. ⚠️ Estado real: la brecha

En la sesión previa, Claude **no pudo pushear el código** al repo `morabessone/innovalport` porque no tenía credenciales de GitHub. Ofreció dos caminos (subir un zip manualmente, o pasar un fine-grained PAT). **Ninguno se concretó: el repositorio estaba completamente vacío al iniciar esta sesión.**

Consecuencia: **el código de arriba no existe en ninguna parte accesible desde acá** — solo su descripción. Para materializarlo hay dos opciones:
- **(A)** Que subas el zip que te habías descargado en esa sesión (si lo conservás) — es el código original tal como se diseñó.
- **(B)** Reconstruirlo desde cero en este repo a partir de estas especificaciones (divergerá en detalles del original, pero respeta el diseño).

## 7. Plan de testing (sin sandbox — todo es producción)

Contabilium no tiene ambiente de pruebas, así que la puesta en marcha es gradual y de riesgo creciente:
1. **Solo lectura, días.** Correr `test-contabilium.mjs`: valida el token, descubre qué endpoints responden (varios nombres varían según la colección Postman), y lista depósitos (con IDs) y productos con stock real. **Los IDs de depósito son el dato base para todo lo demás.**
2. **SKU de prueba** `TEST-CENTRO-STOCK` para probar ingresos y movimientos sin tocar productos reales.
3. **Facturas reales** una vez calibrado el OCR.
4. **NC automática al final**, y la primera validada con el contador (Claudio).

## 8. Pendientes para pasar a producción (del chat previo, cruzados con el relevamiento)

- ✅ Plan Full confirmado.
- ✅ API Key de Contabilium obtenida.
- ⏳ **Config de depósitos en Contabilium**: ¿Genpol / Oficina / Flexit / Full existen como depósitos separados? ¿cuál sincroniza a ML? (Martín dijo en el relevamiento que "refleja los 4 depósitos" — hay que confirmarlo vía API con el script de solo lectura).
- ⏳ **3-5 facturas reales** (foto y PDF) de Maty/LBS y un despacho de importación, para calibrar el OCR con los formatos verdaderos.
- ⏳ **Mail a `api@contabilium.com`** preguntando por los endpoints exactos de movimientos/remitos y ajuste de stock por depósito (estaban marcados `[VERIFICAR]` porque no se pudieron confirmar sin la colección Postman completa).
- ⏳ Credenciales de Supabase una vez creado el proyecto.

## 9. Próximo paso sugerido (Fase 1, riesgo cero)

Conectar la API en modo **solo lectura**: correr `test-contabilium.mjs`, sincronizar catálogo y stock real a Supabase, y que el panel deje de mostrar datos demo para mostrar el stock verdadero. Sin escribir nada en Contabilium todavía.
