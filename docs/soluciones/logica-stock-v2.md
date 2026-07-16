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

### 3.2 Contabilium

- El export **sí da stock por depósito** (Genpol, Full, Flexit, Oficina, +WIGOU/PROVEEDORES a descartar). 140 SKUs, tipos `P` (producto), `V` (variante), `C` (combo).
- **Las columnas Full y Flexit de Contabilium derivan a negativo** (p.ej. BABY-CALL Full −134, KITHERRAMIENTASBICI Full −296, PROYECTOR Full −135). Las ventas se descuentan pero las reposiciones/colectas no siempre se registran. **Conclusión: Contabilium es la verdad para Genpol y Oficina; para Full y Flexit la verdad son ML (`meli_facility`) y el pool real de Flexit.**
- **Combos (tipo C)** traen su composición: `SKU combo → SKU base × Cantidad`.
  Ej.: `COMBO-BABYCALL-2 → 2× BABY-CALL-PORT`, `COMBO-DOMO-3 → 3× CAM-GR-JORTAN-FULL-C`, `COMBO-REFLECTOR200W-2 → 2× REFLEC-200W-PORT`.

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

## 6. Cerrar el loop (write-back) — objetivo final

- Venta en **Tienda Nube** → hay que **bajar el stock en Contabilium** para que ML
  Flex también baje (evita sobreventa). Con la API de ML se puede además
  decrementar directamente el `selling_address` del user_product
  (`PUT /user-products/{id}/stock`), como refuerzo inmediato.
- El write-back a Contabilium sigue en **dry-run** hasta validar los endpoints de escritura.
- Requiere señal de venta: **webhooks/notificaciones** de ML y TN, o polling de `sold_quantity`.

## 7. Preguntas abiertas / lo que hace falta validar

1. **Combos en ML:** ¿el stock del combo está linkeado al base (ML lo descuenta
   solo) o son independientes? Hay que probar con un combo real publicado.
2. **TN:** ¿hay algún webhook/notificación de ventas o de stock, aunque sea básico?
   Para no depender de exports.
3. **available vs split:** confirmar que `selling_address + meli_facility ≈
   available_quantity` de la publicación (en un caso dio 137 vs 125, por ventas
   entre el export y la consulta — normal, pero conviene medir el desfase).
4. **Colectas a Full:** confirmar que el reabastecimiento Genpol→Full es manual y
   cuándo conviene alertar reposición.
