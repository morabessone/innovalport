# API de Contabilium — hallazgos confirmados

Verificado en vivo contra `https://rest.contabilium.com` con la cuenta de Innovalport (julio 2026). Reemplaza a los endpoints `[VERIFICAR]` originales.

## Autenticación
- `POST /token` — `application/x-www-form-urlencoded` con `grant_type=client_credentials`, `client_id` = email de la cuenta, `client_secret` = API Key. Devuelve `{ access_token }`. ✅ Funciona.

## Lectura (confirmado)
- **Productos = "Conceptos".** `GET /api/conceptos/search?filtro=&pageSize=100&page=N`
  → `{ Items: [...], TotalPage, TotalItems }`. Campos por item: `Id`, `Codigo` (SKU), `Nombre`, `CostoInterno`, `PrecioFinal`, `Precio`, `Iva`, **`Stock`** (total), `StockMinimo`, `Estado` (`Activo`/…), `Tipo` (`Producto`/`Servicio`), `SincronizaStock`, `IDProveedor`.
- `GET /api/conceptos/{id}` — detalle de un concepto.

## ⚠️ Stock por depósito: NO disponible en la API
- El campo `Stock` es el **total**, no por depósito.
- El parámetro `idDeposito` en `/api/conceptos/search` **se ignora** (devuelve el mismo total para cualquier valor).
- No hay endpoint de depósitos que responda (`/api/depositos`, `/api/deposito`, `/api/sucursales`, etc. → 404).
- **Conclusión:** el desglose por depósito lo maneja el Centro de Stock (Contabilium manda el total; la app reparte GEN/FLX/FULL y deja el remanente en Oficina).

## Escritura (parcial)
- `PUT /api/conceptos` → **405** (no soportado).
- `POST /api/conceptos` → es el endpoint de escritura, pero **valida el formato del campo `Tipo`** (rechaza el string `"Producto"` que devuelve el GET; espera otro formato/enum). No se confirmó el schema exacto para no arriesgar la cuenta real (sin sandbox).
- **Pendiente:** obtener el schema de `POST /api/conceptos` (o un endpoint de ajuste de stock) desde la documentación oficial de Contabilium o `api@contabilium.com`. Con eso se completa el worker de escritura.
- **Nota de crédito** (para devoluciones): endpoints `AnularComprobanteRápido` / parcial, aún sin confirmar contra la cuenta.

## Estado de la integración
- `stock-sync`: lee catálogo + stock total y reconcilia el reparto. ✅ En producción, cron cada 30 min.
- Escritura hacia Contabilium: **toda operación queda encolada en `cb_queue`** (nada se pierde), pero el worker no la empuja hasta confirmar el schema de escritura.
