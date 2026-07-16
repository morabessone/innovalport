# Lógica de stock v2 — cómo se maneja el stock en la app

> Documento de diseño. Escrito después de investigar a fondo las APIs de Mercado
> Libre y Contabilium, y de conciliar los exports reales (Contabilium por
> depósito, Combos, Flexit, publicaciones de ML). El objetivo es **no agravar el
> problema**: definir una lógica correcta antes de escribir código.

## 1. Modelo físico confirmado (WhatsApp con el equipo)

**Depósitos** (se descartan `WIGOU` y `PROVEEDORES`):

| Depósito | Rol |
|---|---|
| **Genpol** | Depósito principal / bulk. De acá salen las colectas hacia Full. |
| **Full** | Bodega de Mercado Libre. La administra ML. Se abastece con colectas desde Genpol. |
| **Flexit** | Depósito de logística que hace los envíos de **ML Flex y de Tienda Nube**. Pool compartido. |
| **Oficina** | Depósito chico: devoluciones, ajustes manuales. |

**Envíos:**
- **Full** → los hace **Mercado Libre**. Se programan colectas/envíos desde Genpol al depósito de logística de ML; ML entrega.
- **Flex (ML) y Tienda Nube** → los hace **Flexit**. Flexit es el pool compartido de ambos canales.

**Canales de venta:** Mercado Libre (Full y Flex) y Tienda Nube.

## 2. Modelo de publicaciones

Un mismo SKU/producto puede tener **varias publicaciones** en Mercado Libre:
- Publicación **simple** y publicación **en cuotas** (misma cosa, distinto listing).
- Publicación de **catálogo**.
- Publicación **Full**, **Flex**, o **mixta** (stock en las dos ubicaciones a la vez).
- Publicación con **variantes** (color, etc.): cada variante tiene su propio stock.
- Publicación **pack/combo**: vende el SKU de a N (SET X2, X3, X4). Una venta descuenta N unidades del SKU base.

## 3. Investigación de APIs — hallazgos clave

### 3.1 Mercado Libre

- **`logistic_type` NO sirve para separar Full vs Flex.** Todas las publicaciones
  del vendedor devuelven `logistic_type: "fulfillment"` y `shipping_mode: "me2"`,
  incluso las que en la práctica venden desde "mi depósito" (Flex). Clasificar por
  este campo fue el bug que metía todo en Full.
- **La fuente correcta del split es `GET /user-products/{user_product_id}/stock`:**
  ```json
  { "locations": [
      { "type": "selling_address", "quantity": 35 },   // Flex / "mi depósito" (pool Flexit)
      { "type": "meli_facility",   "quantity": 0 }      // Full (bodega de ML)
  ] }
  ```
  Verificado contra el export de publicaciones: coincide exacto.
- **`user_product_id`** (campo del `/items/{id}`) es la **clave de deduplicación
  correcta**: varias publicaciones que comparten stock (simple + cuotas + catálogo)
  comparten `user_product_id`. Hay que agregar por `user_product_id`, **no sumar**
  publicaciones (sumar multiplicaba el stock — el otro bug ya corregido).
- **Variantes:** cada variación tiene su `user_product_id` y su stock; se mapea la
  variación → SKU por `seller_custom_field`/`SELLER_SKU` de la variación.
- `available_quantity` del item es un **único número combinado**; no separa
  ubicaciones. Solo sirve como control.
- Otros campos útiles: `sold_quantity`, `initial_quantity` (velocidad),
  `catalog_listing`, `sale_terms` (cuotas/campañas).

**Endpoints a usar en el sync de ML:**
1. `GET /users/{seller}/items/search?search_type=scan` → todos los item ids.
2. `GET /items?ids=...&attributes=id,status,seller_custom_field,seller_sku,attributes,user_product_id,variations,catalog_listing`
3. Por cada `user_product_id` único: `GET /user-products/{id}/stock` → `selling_address` (Flex) + `meli_facility` (Full).

### 3.2 Contabilium (probado en vivo contra la API real)

Base: `https://rest.contabilium.com` · Auth: `POST /token` (client_credentials, client_id = email, client_secret = API key).

**Lo que la API SÍ da:**
- **Producto / maestro**: `GET /api/conceptos/search?filtro=SKU` y `GET /api/conceptos/{id}` → SKU (`Codigo`), `Stock` (TOTAL), `StockMinimo`, `CostoInterno`, `Tipo`, `Estado`, `SincronizaStock`.
- **Feed de ventas UNIFICADO (ML + TN)**: `GET /api/comprobantes/search?fechaDesde=YYYY-MM-DD&fechaHasta=YYYY-MM-DD` (lista) y `GET /api/comprobantes/{id}` (detalle). Cada comprobante trae:
  - `Origen`: **"MercadoLibre" / "TiendaNube"** ← el canal.
  - `IDVentaIntegracion`: id de la orden en el canal. `IDIntegracion`.
  - `Inventario`: **id del depósito** de donde salió (permite saber si fue Full o Flexit).
  - `Items[]`: `Codigo` (SKU), `Cantidad`, `Concepto`, precios, `Tipo`.
  - `TipoFc` (FCB/FCA), `FechaEmision`, `RazonSocial`, importes, `Cae`.
  - **Esto es la señal para cerrar el loop**: Contabilium ya ingesta las ventas de ML y TN. En vez de cablear webhooks de cada canal por separado, se puede pollear este feed y ver todas las ventas con su canal y depósito.

**Lo que la API NO da:**
- **Stock por depósito**: los endpoints de conceptos devuelven solo `Stock` TOTAL. No hay endpoint de stock por depósito. El desglose por depósito (Genpol/Full/Flexit/Oficina) **sólo sale del export/reporte** (140 SKUs, tipos `P`/`V`/`C`).
- Escritura de stock: los POST probados antes fueron rechazados (formato `Tipo`); queda por validar con la colección Postman oficial.

**Del export (no de la API):**
- Stock por depósito. **Las columnas Full y Flexit derivan a negativo** (p.ej. BABY-CALL Full −134, KITHERRAMIENTASBICI Full −296): ventas se descuentan pero reposiciones/colectas no siempre. Verdad: Genpol/Oficina en Contabilium; Full/Flex en ML.
- **Combos (tipo C)** con su composición `SKU combo → SKU base × Cantidad` (ej. `COMBO-BABYCALL-2 → 2× BABY-CALL-PORT`, `COMBO-DOMO-3 → 3× CAM-GR-JORTAN-FULL-C`).

### 3.3 Flexit

- Su API (`flexit-app.net`) es de **logística/entregas** (entregas, cotizaciones), **no expone stock**; y las credenciales entregadas no tienen permiso de API. Además el usuario no tiene por qué darlo: el pool físico de Flexit = `selling_address` de ML (misma mercadería). El export de Flexit sirve de **control cruzado**.

### 3.4 Tienda Nube

- Sin API disponible por el plan. Stock por export CSV. Como TN comparte el pool
  de Flexit, su disponible teórico = pool Flexit.

## 4. La lógica propuesta (el corazón)

**Principio: una sola fuente de verdad por concepto físico; el resto se deriva.**

### 4.1 Stock físico por depósito

| Depósito | Fuente de verdad |
|---|---|
| **Genpol** | Contabilium (Genpol) |
| **Full** | ML `meli_facility` (por user_product, agregado por SKU) |
| **Flexit** | ML `selling_address` (por user_product, agregado por SKU); export de Flexit como control cruzado |
| **Oficina** | Contabilium (Oficina) |

### 4.2 Publicado / ofertado

- **ML Full** por publicación = `meli_facility` del user_product.
- **ML Flex** por publicación = `selling_address` del user_product.
- **Tienda Nube** = export (hasta tener API). Tira del pool Flexit.
- **Pool compartido** = Flexit (`selling_address`) → abastece ML Flex + TN.

### 4.3 Packs / combos

- Cada publicación tiene un **factor** = unidades de base por venta (1 normal; 2/3/4 combo).
- El factor sale de la tabla de combos de Contabilium (`SKU combo → base × cantidad`).
- La **demanda sobre el pool** de un SKU base = Σ(disponible de cada publicación × factor).
- ⚠️ **A validar:** si en ML el stock del combo está *linkeado* al base (ML lo descuenta solo) o son stocks independientes que el vendedor mantiene a mano. Cambia cómo se calcula el disponible.

### 4.4 Detección de sobreventa (lo que evita el problema #1)

Por cada SKU base:
- `pool_flex` = Flexit físico (selling_address total del SKU, en unidades base).
- `demanda_flex` = Σ(ML Flex ofertado × factor de cada publicación) + TN ofertado.
- **Sobreventa** si `demanda_flex > pool_flex` (se oferta más de lo que hay físicamente).
- **Desincronizado** si ML Flex y TN publican distinto del mismo pool.
- **Full** es independiente: `pool_full = meli_facility`; se abastece por colectas desde Genpol. Alerta de reposición cuando `pool_full` baja y hay stock en Genpol.

## 5. Flujo de sincronización propuesto

1. **ML sync** (cada N min): scan → agrega por `user_product_id` → guarda `Full`
   (meli_facility) y `Flex` (selling_address) por producto/variante. Mapea combos
   a su base con el factor.
2. **Contabilium sync**: stock por depósito (Genpol, Oficina) + tabla de combos.
3. **Flexit / TN**: por export por ahora (control cruzado / conciliación).
4. **Reconciliar**: calcular sobreventa/reposición y mostrar en el Panel.

## 6. Estrategia: Contabilium como centro (decisión del equipo)

> "Si podés usar todo a través de Contabilium —que justamente provee la
> integración entre ML y TN, manejo de depósitos, remitos, facturación— mejor.
> Esta app es la versión simple para manejar estas cosas, manteniendo todo en
> Contabilium e integrando lo necesario."

La app **no reimplementa** la integración: se apoya en Contabilium como sistema
de registro y agrega la capa que hoy falta (visibilidad por canal, alerta de
sobreventa, alerta de reponer Full). Reparto de responsabilidades:

| Dato / acción | Fuente / destino |
|---|---|
| Maestro de productos, costo, stock TOTAL, mínimos | Contabilium API (`/api/conceptos`) |
| **Ventas por canal** (ML + TN), depósito, SKU, cantidad | Contabilium API (`/api/comprobantes`) — **feed unificado** |
| Stock por depósito (Genpol/Full/Flexit/Oficina) | Export de Contabilium (no hay API) + se deriva de las ventas |
| Split Full vs Flex por publicación | ML API (`/user-products/{id}/stock`) |
| Combos (pack × N) | Export de combos de Contabilium |
| Remitos / facturación / colectas | Se hacen en Contabilium (la app solo muestra/alerta) |

**Cerrar el loop (evitar sobreventa TN↔ML):**
- Contabilium ya recibe las ventas de ambos canales y descuenta el stock TOTAL.
  El problema real es el **desfase por depósito/pool** y el **timing**.
- La app **polea `/api/comprobantes`** (cada pocos minutos) → detecta ventas
  nuevas por `Origen` y `Inventario` → recalcula el pool de Flexit y **alerta**
  si un canal quedó ofertando de más.
- Refuerzo opcional inmediato: ante una venta, decrementar el `selling_address`
  del user_product en ML (`PUT /user-products/{id}/stock`) para que ML Flex baje
  al toque. El write-back a Contabilium se mantiene en **dry-run** hasta validar.
- **Tienda Nube** además ofrece webhooks `order/created` y `order/paid`
  (docs.tiendanube.com) como señal inmediata, complementaria al feed de Contabilium.

## 7. Reposición de Full

- Full se abastece con **colectas manuales Genpol→Full** (las programa el equipo,
  las retira ML de Genpol).
- La app **solo muestra un cartel "hay que reponer Full"** cuando el stock de Full
  (`meli_facility`) baja de un umbral y hay stock en Genpol. No automatiza nada.

## 8. Preguntas abiertas / lo que falta validar

1. **Combos en ML:** ¿ML descuenta solo el stock del base al vender un combo, o
   son stocks independientes? (a investigar; el equipo no lo tiene claro). Afecta
   cómo se calcula el disponible con packs.
2. **available vs split:** medir el desfase entre `selling_address + meli_facility`
   y `available_quantity` (un caso dio 137 vs 125, por ventas entre export y
   consulta — normal, pero conviene monitorearlo).
3. **Escritura en Contabilium:** validar el endpoint de ajuste de stock con la
   colección Postman oficial (hoy en dry-run).
4. **Stock por depósito sin export:** evaluar reconstruirlo con export baseline +
   movimientos derivados del feed de comprobantes (`Inventario` por venta), para
   no depender de subir el export a mano.
