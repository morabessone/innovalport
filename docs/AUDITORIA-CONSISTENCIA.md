# Auditoría de consistencia — Contabilium como fuente de verdad

Modelo: **Contabilium es la verdad del stock por SKU y depósito.** `deposito-sync`
la trae cada 5 min y sobrescribe la tabla `stock`. Toda mutación local de la app
además **encola** su cambio a Contabilium (`cb_queue`), para que al habilitar
escritura Contabilium quede correcto y el espejo reconcilie.

## Quién escribe qué (una sola autoridad por dato)

| Dato | Fuente / escritor | Estado |
|------|-------------------|--------|
| Catálogo (SKU, cb_producto_id, costo, mínimo, activo) | `stock-sync` ← Contabilium conceptos | ✅ |
| Stock por depósito (cantidad + reservado) | `deposito-sync` ← Contabilium getStockByDeposito | ✅ autoridad |
| Publicado por canal (ml_full, ml_flex) | `canal-sync` ← API de ML | ✅ |
| Feed de ventas (cb_ventas) | `ventas-sync` ← Contabilium comprobantes (solo registra) | ✅ |
| Devoluciones | `devoluciones-sync` ← ML + carga manual | ✅ |
| Mutaciones (ingreso, movimiento, inventario, devol.) | `acciones` → espejo + `cb_queue` | ✅ |

## Inconsistencias encontradas y corregidas en esta auditoría

1. **`stock-sync` repartía stock por depósito** (total − asignado → OFI), pisando
   a `deposito-sync`. → Ahora solo mantiene el **catálogo**; no toca stock.
2. **`ventas-sync` descontaba stock** del espejo por cada venta, pisando a
   `deposito-sync` (Contabilium ya descuenta). → Ahora **solo registra** la venta
   en `cb_ventas` (feed/historial); no toca stock.
3. **Movimiento** solo tocaba el espejo (se revertía en la sync). → Ahora encola
   el traslado a Contabilium como dos ajustes (−origen, +destino); regla: salida
   de Oficina sin remito.
4. **Devolución apta con reubicación** movía OFI→destino solo en el espejo. →
   Ahora también encola los dos ajustes a Contabilium.
5. **Bug de endpoint**: el worker apuntaba a `/api/stock/ajuste` (404). Corregido
   a `/api/conceptos/ajustarStock`.

## Resultado

Con esto hay **una sola autoridad por dato** y ninguna sync pisa a otra. El stock
que se ve = lo que dice Contabilium. Cada acción (ingreso, movimiento, inventario,
devolución) queda encolada hacia Contabilium para mantener la consistencia.

## Contratos de escritura de Contabilium — CONFIRMADOS (sondas con id inexistente)

Validados sin cambiar nada real (id falso → "el concepto no existe" = formato OK):

| Acción | Endpoint confirmado |
|--------|---------------------|
| Ajustar stock | `GET /api/conceptos/ajustarStock?id={concepto}&idDeposito={dep}&cantidad={n}` |
| Dar de baja producto | `GET /api/conceptos/darDeBaja?id={concepto}` |
| Reactivar producto | `GET /api/conceptos/darDeAlta?id={concepto}` |
| Crear producto | `POST /api/conceptos` (body con la estructura del concepto) |

El worker (`_shared/contabilium.ts`) ya usa estos endpoints. Sigue en **dry-run**:
registra el plan exacto en `cb_queue.simulacion` para revisarlo antes de ejecutar.

### Lo único que falta confirmar (1 test controlado, reversible)
- **`cantidad` en `ajustarStock`: ¿DELTA o ABSOLUTO?** No se deduce por sonda
  (requiere tocar un SKU real y observar). Se confirma con **un** test reversible:
  ajustar +1 en un SKU, mirar `getStockByDeposito`, y revertir. Para el conteo
  inicial conviene absoluto; si es delta, el worker calcula `delta = contado − actual`.
- **Ingreso de producto NUEVO**: crear el concepto en Contabilium
  (`POST /api/conceptos`) ANTES del ajuste de stock, para obtener su
  `cb_producto_id`. (Flujo de Ingreso — en construcción.)
- **`nota_credito`** (devoluciones): endpoint aún sin ubicar. Baja prioridad
  (la devolución no lo necesita para el stock).

## Secuencia para arrancar

1. (Ahora) Todo en lectura: el panel muestra el stock real de Contabilium.
2. Resolver los 3 pendientes de arriba y validar el worker en dry-run.
3. **Conteo inicial** → habilitar escritura → el conteo fija el stock real en
   Contabilium por SKU/depósito.
4. Desde ahí, cada venta / movimiento / ingreso / devolución mantiene la
   consistencia a través de Contabilium.
