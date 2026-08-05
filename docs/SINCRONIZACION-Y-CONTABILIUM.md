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

## 4. La sobreventa: por qué pasa y cómo cerrarla

Hoy, si se vende 1 unidad por ML Flex, ML baja su propio pool; pero **Tienda
Nube no se entera automáticamente** (Contabilium no empuja). Ese es el hueco.

Para cerrarlo hay dos caminos, ambos implican **escritura** (hoy en pausa):

1. **Activar `SincronizaStock` en el panel de Contabilium** para que Contabilium
   empuje stock a ML y TN. Es "no reinventar la rueda", pero hay que:
   - Verificar en el panel que la integración de stock exista y funcione bien.
   - Probar en 1–2 SKUs que al vender por un canal baje en el otro.
   - Riesgo: si Contabilium empuja el número equivocado (ej. el Full negativo),
     rompe publicaciones. Requiere que el stock por depósito esté sano primero.

2. **Que la app sea la autoridad**: al detectar una venta (feed de comprobantes
   + webhooks de TN), recalcular el pool por SKU y escribir el stock corregido a
   ML por API (y avisar el ajuste de TN). Más control, pero es lógica propia.

**Recomendación**: intentar primero el camino 1 (Contabilium), porque es su
función natural y evita lógica paralela — pero **solo después** de tener el stock
por depósito sano (Full desde ML, no desde el Full negativo de Contabilium), y
probándolo en pocos SKUs. Si Contabilium no sincroniza bien, recién ahí pasar al
camino 2.

Mientras tanto (solo lectura), la app **detecta** el riesgo: marca en rojo cuando
`ML Flex` o `TN` publicado supera el disponible real del pool Flexit
(`StockConReservas`).

## 5. Próximo paso propuesto (cuando se decida)

1. Migrar la fuente de stock por depósito (Genpol, Flexit, Oficina) a
   `getStockByDeposito` — lectura directa de Contabilium, reemplaza exports.
2. Mantener Full desde la API de ML.
3. Sumar `StockReservado` a la vista para mostrar disponible real.
4. Recién con eso sano, evaluar prender la sincronización hacia canales
   (Contabilium primero; app como plan B).
