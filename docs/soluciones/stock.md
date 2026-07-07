# Solución de Stock — Innovalport / Cominarsa

Estado: **diseño completo (100% de la forma conceptual), arquitectura técnica resuelta, pendiente de materializar el código en el repo y de decisiones operativas de Martín.**
Fuente: relevamiento a Javier (fuente principal), cruzado con Martín y Tomás. Ver [`../relevamiento/`](../relevamiento/).

> **La arquitectura técnica de esta solución (APIs, stack, artefactos) ya está resuelta** en una sesión de diseño previa — ver [`./arquitectura-tecnica-stock.md`](./arquitectura-tecnica-stock.md). Este documento es el diagnóstico operativo (as-is → to-be) desde el relevamiento; aquel es la construcción técnica desde la investigación de las APIs. Se leen juntos.

## 0. Por qué el stock es la prioridad #1

Cuando se preguntó a cada persona "si pudieras automatizar UNA sola cosa", la respuesta convergió sola, sin que se la sugiriéramos:

- **Martín**: "Gestión de stock."
- **Javier**: "El control del stock, sin dudas." Y sobre qué es lo más desordenado: **"No saber concretamente la cantidad de stock que tenemos y en qué depósito."**
- **Tomás**: no lo nombra como su tarea a automatizar, pero confirma el síntoma: **"Pasa 3 veces por semana mínimo"** que venden algo sin stock real, y **"siempre"** se quedan sin stock en Full de productos que venden bien.

Este documento diagrama la solución completa: diagnóstico (as-is), causas raíz, diseño objetivo (to-be) y roadmap de implementación.

## 1. Mapa actual de depósitos (as-is)

| Depósito | Naturaleza | Ubicación | Encargado físico | Refleja en Contabilium |
|---|---|---|---|---|
| **Genpol** | Depósito fiscal de un tercero, alquilado | Don Torcuato | Sergio (de Genpol) | Sí — cada movimiento requiere remito |
| **Flexit** | Operador logístico de terceros (no es depósito propio) | Monserrat, CABA | Flexit (tercero) | Parcial — solo se registra al retirar de Genpol hacia Flexit; el ingreso a Flexit se anota aparte en Excel/WhatsApp |
| **Full** | Depósitos de Mercado Libre | — | ML | Vía integración ML↔Contabilium, **incompleta** (solo algunos SKUs) |
| **Oficina** | Propia, alquilada | Olivos / Vicente López (a confirmar) | Javier / Carla | Sí, en teoría — poco stock, foco en revisión de devoluciones |

Flujo físico típico:

```
China (Alibaba) ──90-100 días──▶ Genpol ─┬─▶ Flexit ──▶ venta Flex (ML + TN)
                                          ├─▶ Full (vía colecta ML) ──▶ venta Full
                                          └─▶ Oficina (stock mínimo)
Proveedores locales (Maty, LBS) ──Javier──▶ Genpol / Flexit / Oficina (según destino que decide Javier al cargar la compra)

Devoluciones: Full/Flex ──(jueves, Javier retira)──▶ Oficina ──▶ apta: vuelve a Flexit o Genpol
                                                             └──▶ no apta: queda acumulada, sin destino definido
```

## 2. Causas raíz (por qué hoy nadie sabe cuánto stock hay y dónde)

Cada una de estas está confirmada por al menos dos fuentes independientes del relevamiento:

1. **No todos los movimientos generan remito.** Javier lo marcó él mismo como "IMPORTANTE": mover algo de la Oficina a un depósito **no genera remito**, "porque no tenemos un control de stock interno". El movimiento más frecuente de todos (Genpol → Flexit, casi diario) **se registra en una planilla de Excel y un mensaje de WhatsApp, no en Contabilium.**
2. **La integración ML ↔ Contabilium es parcial.** Tomás: "está conectado únicamente en algunos productos. En otros no, y tenemos que tocarlo a mano, esto nos genera muchísimas fallas." Consecuencia directa: sobreventa 3 veces por semana como mínimo.
3. **No se controla la cantidad física recibida contra la factura/packing antes de cargar.** Ni en Genpol (solo hay una verificación informal con Sergio) ni al recibir de proveedores locales.
4. **La carga en Contabilium dependía de una sola persona con errores conocidos.** Antes Santiago ("las cargaba mal o se olvidaba"), ahora Javier — sigue siendo un punto único de falla, sin doble control.
5. **Nunca se hizo un conteo físico de inventario** (Javier: "Nunca. Hay que hacerlo ya"). Martín menciona 3 conteos históricos con diferencias significativas, atribuidas a devoluciones no cargadas — o sea, ni siquiera esos 3 conteos cerraron el ciclo completo.
6. **Las devoluciones son un agujero total.** No hay SKU de devolución, no hay remito automático confiable de retiro, no hay criterio escrito de apto/no apto, y las no aptas se acumulan sin decisión ni registro de la pérdida. Esto ensucia cualquier conteo de stock, porque unidades "vueltas" a veces no se cargan.
7. **No hay reposición basada en datos.** El criterio de qué mandar a Full/Flex es "por proximidad de falta de stock" (reactivo) o "a ojo" mirando ventas semanales (Tomás) — no hay punto de repedido ni alerta de stock mínimo por SKU/depósito.
8. **Costos "sucios" en Contabilium** distorsionan el margen, pero esto es secundario al problema de cantidades — se resuelve después.

**Síntesis del problema en una frase:** hay 4 ubicaciones físicas y al menos 3 formas distintas de registrar (o no registrar) un movimiento entre ellas — Contabilium, una planilla de Excel, y la memoria/WhatsApp del equipo — y ninguna es la fuente de verdad completa.

## 3. Principio de diseño

> **Un único movimiento de stock, un único registro, siempre.** Todo lo demás (Excel, WhatsApp, memoria) desaparece como sistema de registro y queda, como mucho, como canal de aviso/notificación — nunca como fuente de datos.

Esto implica que **todo movimiento físico de mercadería, sin excepción, genera un remito digital en el momento**, sin importar el depósito de origen/destino (incluida Oficina → cualquier depósito, que hoy es la excepción no registrada). Sin remito, la mercadería "no se movió" a los ojos del sistema — esa es la regla que hay que instalar culturalmente en el equipo, no solo técnicamente.

**Cómo se materializa (decidido en la arquitectura técnica):** la fuente de verdad es **Contabilium** (que ya tiene el stock y las integraciones nativas con ML/TN). No se reemplaza. Se construye un **"Centro de Stock"** — un panel único encima de Contabilium — que elimina la carga manual y hace que registrar un movimiento sea un tap (foto de factura con OCR, remito de movimiento automático, pipeline de devoluciones). El equipo deja de "cargar cosas en Contabilium a mano"; el Centro de Stock lo hace por ellos vía API. Ver detalle en [`./arquitectura-tecnica-stock.md`](./arquitectura-tecnica-stock.md).

## 4. Modelo de datos objetivo

**Depósitos** (dimensión fija, la misma que ya usa Contabilium):
`GENPOL | FLEXIT | FULL | OFICINA`

**Movimiento de stock** (evento atómico — es la única fuente de verdad):
- `sku`
- `cantidad`
- `deposito_origen` (nulo si es un ingreso desde compra/importación)
- `deposito_destino` (nulo si es un egreso por venta o baja)
- `tipo`: `ingreso_compra_local | ingreso_importacion | movimiento_interno | venta | devolucion_ingreso | devolucion_baja | ajuste_inventario`
- `remito_id` / `referencia` (número de remito de Contabilium, o número de compra/factura)
- `responsable` (quién lo generó)
- `timestamp`
- `evidencia` (foto/PDF del remito o factura del proveedor — hoy se pierde en el chat de WhatsApp)

**Stock por SKU y depósito** = vista calculada (no tabla manual) a partir de la suma de movimientos. Esto es lo que hoy nadie tiene: una foto en tiempo real de "cuánto hay de cada SKU en cada depósito", calculada — no tipeada a mano en ningún lado.

**SKU de devolución / lote de devolución**: cada devolución que ingresa genera un registro propio vinculado al SKU original, con estado (`pendiente_revision | apta | no_apta`) y motivo — hoy no existe ningún identificador para esto.

## 5. Rediseño de los 4 flujos críticos

### 5.1 Ingreso de mercadería (compra local, importación)
1. Javier o quien retire registra el ingreso **el mismo día**, con foto del remito/factura del proveedor como evidencia adjunta (reemplaza el "se lo queda él" y "lo manda al grupo" actual).
2. Antes de cargar, se coteja cantidad física vs. documento (hoy no se hace nunca) — aunque sea un chequeo simple de cantidad, no de calidad.
3. Para importación: se carga contra el despacho, con el costeo real (FOB + flete + seguro + aranceles + despachante + flete interno) desde la planilla de costeo existente — no el costo "sucio" actual.
4. Definir destino (Genpol/Flexit/Full/Oficina) en el mismo acto de carga.

### 5.2 Movimiento interno entre depósitos
1. **Todo movimiento genera remito en el sistema, sin excepción** — incluido Genpol→Flexit (el más frecuente, hoy en Excel) y Oficina→cualquiera (hoy sin registro).
2. El remito se genera antes o en el momento del movimiento físico, no después ni "cuando haya tiempo".
3. El WhatsApp puede seguir existiendo como aviso humano ("ya salió tal cosa para Flexit"), pero deja de ser el registro — el registro vive en el sistema.

### 5.3 Egreso por venta (ML Full, ML Flex, Tienda Nube)
1. Auditar y cerrar la integración ML ↔ Contabilium para el 100% de los SKUs activos (hoy es parcial — causa directa de la sobreventa 3x/semana). Este es probablemente el arreglo de mayor impacto con menor esfuerzo de todo el proyecto.
2. Reposición a Full/Flex basada en punto de repedido por SKU (ventas de los últimos N días vs. stock disponible + lead time de reposición), no "a ojo" ni "por proximidad de quiebre".
3. Alertas cuando un SKU en Full/Flex cae debajo del umbral, con anticipación suficiente para el próximo turno de envío (hoy 1-2 veces por semana).

### 5.4 Devoluciones
1. Crear el **SKU/lote de devolución** en el mismo momento en que Javier retira de Genpol/Flexit los jueves — hoy el retiro no queda vinculado a nada hasta que llega a la oficina.
2. Formalizar cadencia semanal real (hoy es más bien quincenal según volumen) y criterio escrito de apto/no apto (hoy es tácito entre Carla, Martín y Javier).
3. Definir y registrar el destino de las no aptas (outlet, repuestos, descarte — las 3 opciones que el propio equipo identificó) en vez de acumularlas sin decisión.
4. Registrar la pérdida asociada a cada no apta (hoy: "no se anota en ningún lado").
5. Nota de crédito: el "punto a chequear" original **queda resuelto técnicamente** — Contabilium tiene endpoints `AnularComprobanteRápido` (NC a partir de un comprobante existente) y `AnularComprobante Manual/Parcial` (devoluciones parciales), así que el Centro de Stock puede emitirla automáticamente al marcar una devolución como apta. Falta definir el criterio de negocio: en ML casi nunca hace falta (la plataforma resuelve el reintegro directo, según Carla); para Tienda Nube no hay procedimiento definido todavía. La primera NC automática se valida con el contador (Claudio).

### 5.5 Conteo físico de inventario (cycle count)
1. Instalar un conteo físico periódico real (nunca se hizo). Empezar simple: conteo rotativo por depósito, no los 4 al mismo tiempo.
2. Reconciliar automáticamente contra el stock calculado por movimientos, y **exigir explicación de toda diferencia** (hoy las diferencias se atribuyen genéricamente a "las devoluciones", sin confirmarlo).

## 6. Alertas y reporting (lo que hoy nadie puede ver)

- Stock por SKU y por depósito, en tiempo real — hoy nadie lo puede responder con certeza (cita directa de Javier).
- Alerta de stock mínimo / punto de repedido por SKU antes de que se corte una publicación activa (72 publicaciones activas hoy, "muchísimas más sin stock" — Tomás).
- Alerta de sobreventa (venta sin stock real) apenas ocurre, no después.
- Antigüedad de stock en Full (para evitar los cargos de ML por almacenamiento/antigüedad que hoy Tomás controla manualmente).
- Reporte semanal de devoluciones: volumen, motivo, aptas vs. no aptas, pérdida acumulada.

## 7. Roadmap propuesto

**Fase 0 — Higiene inmediata (días, sin desarrollo):**
- Regla de "sin remito no se movió" comunicada y aplicada por el equipo ya, aunque el remito se siga haciendo en Contabilium a mano.
- Auditar y arreglar qué SKUs no están sincronizados ML↔Contabilium (arregla directamente la sobreventa 3x/semana).
- Definir criterio escrito de apto/no apto de devoluciones y destino de las no aptas.
- Agendar el primer conteo físico completo, depósito por depósito.

**Fase 1 — Fuente de verdad única:**
- Eliminar la planilla de Excel de Genpol→Flexit: todo movimiento pasa a registrarse en Contabilium (o en una capa liviana que registre el evento y lo vuelque a Contabilium).
- SKU/lote de devolución con estado y trazabilidad.

**Fase 2 — Automatización:**
- Alertas de stock mínimo / reposición por SKU y depósito.
- Dashboard de stock en tiempo real por depósito (responde directamente el dolor #1 de Javier y Martín).
- OCR/LLM para carga de facturas/remitos de proveedores locales (reduce el cuello de botella de carga manual de Javier).

**Fase 3 — Cierre del ciclo financiero:**
- Costeo real (no "sucio") cargado en Contabilium para que el margen calculado sea confiable.
- Conciliación automática de liquidaciones ML vs. ventas (hoy: nadie la hace).

## 8. Decisiones que necesitamos de Martín antes de construir

1. ~~¿La fuente de verdad va a ser Contabilium mismo o una capa propia?~~ **RESUELTO** (arquitectura técnica): Contabilium es la fuente de verdad, con una capa de operación ("Centro de Stock") encima. No se reconstruyen las integraciones nativas ML/TN. Ver [`./arquitectura-tecnica-stock.md`](./arquitectura-tecnica-stock.md).
2. ¿Quién es el segundo responsable de carga además de Javier? Hoy es un punto único de falla declarado por el propio Javier ("casi todos los movimientos de Contabilium [los hago yo]"). El Centro de Stock reduce el riesgo (cualquiera puede cargar con una foto), pero conviene definir un backup humano.
3. Confirmar destino real de las devoluciones no aptas (outlet / repuestos / descarte) — quién decide caso a caso y con qué margen de autonomía sin consultar a Martín.
4. Acceso a Contabilium (usuario colaborador / API key de solo lectura para empezar) para poder diagnosticar el estado real de datos antes de definir el modelo final.
5. Confirmar dirección real de la Oficina (Olivos según Martín, Vicente López según Javier — inconsistencia menor a resolver).

## 9. Qué falta para llegar al 100% de evidencia (no de diseño)

El diseño de arriba ya está completo con lo relevado. Para pasar a construcción con confianza total falta la evidencia que el cuestionario original pedía y todavía no se adjuntó:
- Export de movimientos de stock / remitos de Contabilium (para auditar el estado real, no solo lo declarado).
- Export completo del catálogo (SKU, costo, precio, stock por depósito).
- 3-4 facturas/remitos reales de proveedores locales (para diseñar bien la carga/OCR).
- Reporte de devoluciones existente, si lo hay, aunque sea parcial.
