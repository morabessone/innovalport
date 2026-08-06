# Sincronización de stock, canales y sobreventa — hallazgos y propuesta

> Nota de estado: **todo esto es SOLO LECTURA**. La app no escribe stock a
> Mercado Libre, Tienda Nube ni Contabilium. Este documento deja anotado qué
> se puede hacer y cómo, para decidir más adelante.

## 1. De dónde sale hoy cada número (fuentes mixtas)

| Dato | Fuente hoy | Confiable |
|------|-----------|-----------|
| Genpol (depósito) | Contabilium | sí |
| Full (depósito) | API de ML (`meli_facility`) | sí |
| Flexit (depósito) | export de Flexit | sí (manual) |
| Oficina (depósito) | Contabilium | sí |
| ML Full / ML Flex (publicado) | API de ML | sí |
| Tienda Nube (publicado) | export de TN | sí (manual) |

No sale todo de Contabilium. Es una mezcla.

## 2. Qué expone la API de Contabilium (investigado en vivo)

Autenticación: `POST /token` (client_credentials). Endpoints confirmados:

- **`GET /api/inventarios/getdepositos`** → lista de depósitos con su `Id`:
  - FLEXIT = `97439`
  - FULL = `113649` (Direccion: "Mercadolibre")
  - GENPOL = `109341`
  - OFICINA = `127530`
  - PROVEEDORES = `117343` (descartar)
  - WIGOU = `110284` (descartar)

- **`GET /api/inventarios/getStockByDeposito?id={idDeposito}&pageSize={n}&pageNo={p}`**
  → **stock por SKU dentro de ese depósito**, paginado. Cada ítem trae:
  - `Codigo` (SKU), `StockActual`, `StockReservado`, `StockConReservas`.
  - `StockConReservas = StockActual − StockReservado` = **disponible real**.
  - Esto es exactamente "stock por depósito, por SKU" — y **con reservas**, que
    es la señal clave contra la sobreventa (unidades ya comprometidas por ventas
    en curso).

- `GET /api/conceptos/search` y `GET /api/conceptos/{id}` → producto con `Stock`
  **total** (no por depósito), costo, precio, `StockMinimo`, `SincronizaStock`.

### Lo que la API de Contabilium NO expone
- ❌ **Publicaciones por canal**: no hay `/api/publicaciones`, `/api/canales`,
  `/api/integraciones`, `/api/mercadolibre` ni `/api/tiendanube` (todos 404).
  Contabilium tiene la integración por dentro (en su panel web), pero **no la
  ofrece por API**. "Qué está publicado en cada canal" no se puede leer desde
  Contabilium.

### Dato crítico: el depósito FULL en Contabilium está desincronizado
`getStockByDeposito` sobre FULL (113649) devuelve **stock negativo absurdo**
(ej. BABY-CALL −134, BACHA-SMART −18). No refleja lo que hay en ML Full.
**Para Full hay que seguir usando la API de ML (`meli_facility`), no Contabilium.**

### `SincronizaStock: false`
Todos los productos tienen `SincronizaStock=false`. Es decir, **Contabilium NO
empuja stock hacia los canales**. Registra ventas (`/api/comprobantes`), pero no
actualiza las publicaciones de ML/TN. Por eso Contabilium, tal como está hoy,
**no previene la sobreventa por sí solo**.

## 3. Respuesta a "¿se puede manejar todo desde Contabilium?"

Parcialmente, y conviene aprovecharlo:

- ✅ **Stock físico por depósito por SKU** (Genpol, Flexit, Oficina): SÍ, con
  `getStockByDeposito`. Podemos reemplazar los exports manuales de Genpol/Flexit
  por lecturas directas a Contabilium. **No reinventamos la rueda.**
- ✅ **Reservas por SKU** (`StockReservado`): disponible → permite mostrar
  "disponible real" y detectar sobreventa antes de que ocurra.
- ✅ **Ventas unificadas ML+TN**: `/api/comprobantes` (ya se usa).
- ❌ **Publicado por canal**: NO por API → seguimos necesitando la API de ML
  (Full, ML Flex) y el export/estado de TN.
- ❌ **Full**: el depósito Full de Contabilium no es confiable → API de ML.
- ❌ **Empujar stock a canales / prevenir sobreventa automáticamente**: hoy no,
  porque `SincronizaStock=false`.

## 4. Decisión adoptada: la app da VISIBILIDAD, no escribe a los canales

No hace falta empujar stock a ML/TN automáticamente ni activar `SincronizaStock`.
El modelo elegido es más simple y de menor riesgo:

- **Contabilium es la fuente de verdad** del stock por SKU y depósito. Ya
  descuenta cada venta y maneja **combos y cuotas**, así que ese número es real.
- **La app lee** ese stock (todos los depósitos) + lo **publicado** por canal
  (ML por API) y lo muestra junto, por SKU, con el **disponible** (físico −
  reservado) y una **alerta de sobreventa** cuando un canal oferta más que el
  disponible del pool Flexit.
- Con esa visibilidad, **las personas** deciden qué publicar o cuánto mandar a
  cada depósito. La app no toca las publicaciones.

Residual honesto: al ser visibilidad (no bloqueo), una venta entre dos vistas
podría dejar por segundos una publicación por encima del disponible; la alerta lo
marca enseguida para corregir a mano. Es el trade-off aceptado a cambio de no
escribir nada automático.

### El único write (a futuro, cuando se habilite)
El **conteo inicial**: cuando arranquen a usar la app y cuenten físicamente, ese
número se escribe **a Contabilium** (por SKU y depósito) para dejar el stock 100%
real. De ahí en más, Contabilium lo mantiene con ventas / movimientos /
devoluciones. Ese write sigue **apagado** hasta que se avise.

> Importante: escribir el conteo a Contabilium deja el **depósito** correcto,
> pero **no** sincroniza solo las publicaciones (porque `SincronizaStock=false`).
> Las publicaciones se ajustan a mano mirando la app, o —si más adelante se
> quiere automático— habría que activar la sincronización de Contabilium o que la
> app escriba a los canales. Hoy: ninguna de las dos.

## 5. Estado de implementación (todo lectura)

- ✅ `deposito-sync`: trae stock por SKU y depósito desde Contabilium
  (`getStockByDeposito`, paginado con `page`) para Genpol, Flexit, Oficina y Full.
  Escribe solo en la tabla `stock` de la app (cantidad + reservado). Cron cada
  30 min. Reemplaza los exports manuales de depósitos.
- ✅ `canal-sync`: publicado en ML (ML Full / ML Flex) por API. Ya no pisa el
  depósito Full (ese lo trae `deposito-sync` desde Contabilium, negativos
  incluidos, para corregir).
- ✅ Panel: por SKU muestra `Full → ML Full`, `Flexit (disponible, −reservado) →
  ML Flex · Tienda Nube`, respaldo `Genpol / Oficina`, total y alerta de
  sobreventa (celda en rojo cuando publicado > disponible).
- ⏳ Pendiente y apagado: conteo inicial → escritura a Contabilium.
- 🔎 A confirmar con Javier: que las ventas de Tienda Nube en Contabilium
  descuenten del depósito Flexit (visto en datos, con pocas muestras).
