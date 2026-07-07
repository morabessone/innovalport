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

## 5. Artefactos (reconstruidos en este repo)

El código se reconstruyó desde estas especificaciones y desde el relevamiento.
Estado actual:

| Artefacto | Qué es | Ubicación |
|---|---|---|
| Panel React (4 flujos, modo demo) | Panel único de operación | `web/` |
| Esquema de base | Tablas espejo + capa operativa | `supabase/migrations/0001_init.sql` |
| RLS | Lectura anon, escritura solo por functions | `supabase/migrations/0002_rls.sql` |
| Funciones SQL | Ajuste de stock espejo atómico | `supabase/migrations/0003_functions.sql` |
| Seed | 4 depósitos + SKUs de ejemplo | `supabase/seed.sql` |
| `stock-sync` | Lee Contabilium → espejo (solo lectura) | `supabase/functions/stock-sync/` |
| `contabilium-worker` | Drena la cola → escribe en Contabilium (throttle, backoff 429) | `supabase/functions/contabilium-worker/` |
| `ocr-ingreso` | Foto de factura → renglones (Claude + matching SKU) | `supabase/functions/ocr-ingreso/` |
| `acciones` | Movimiento / ingreso / devoluciones | `supabase/functions/acciones/` |
| Cliente Contabilium | Token cache + endpoints configurables | `supabase/functions/_shared/contabilium.ts` |
| Script de sondeo | Test de solo lectura de la API | `scripts/test-contabilium.mjs` |
| README + `.env.example` | Puesta en marcha end-to-end | raíz del repo |

## 6. Estado real: brecha cerrada

En la sesión previa (claude.ai) el código se diseñó pero **nunca se pusheó** al
repo (Claude no tenía credenciales de GitHub), y el repositorio quedó vacío. En
esta sesión se **reconstruyó end-to-end** a partir de estas especificaciones y del
relevamiento, y quedó commiteado. Difiere en detalles del original de aquella
sesión, pero respeta la misma arquitectura. El build de la web compila y corre.

Falta para producción: aplicar el esquema en un proyecto Supabase real, deployar
las functions, cargar credenciales, y confirmar los endpoints `[VERIFICAR]` de
Contabilium con el sondeo. Detalle en el README y en §8.

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
