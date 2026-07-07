# Centro de Stock — Innovalport

Un solo lugar para controlar el stock de Innovalport (importación, depósitos,
ventas y devoluciones), conectado a Contabilium y Mercado Libre, sin cargar nada
a mano en Contabilium.

- **Contabilium** sigue siendo la fuente de verdad del stock y sus integraciones
  nativas con Mercado Libre y Tienda Nube no se tocan.
- El Centro de Stock es **una capa por encima**: elimina la carga manual y agrega
  lo que falta (ingreso por foto, remitos automáticos, pipeline de devoluciones).

> Contexto del negocio y diseño de la solución: ver [`docs/`](./docs).
> Propuesta visual para el equipo: [`docs/soluciones/propuesta/centro-de-stock.html`](./docs/soluciones/propuesta/centro-de-stock.html).

## Arquitectura

```
  Panel web (React)               ← el único lugar donde opera el equipo
       │  lee stock (anon)  │  dispara acciones
       ▼                    ▼
  Supabase Postgres  ◄──  Edge Functions
   (espejo + capa         ├─ stock-sync         (lee Contabilium → espejo)
    operativa: cola,       ├─ acciones           (mover/ingresar/devolver)
    remitos, devol.,       ├─ ocr-ingreso        (foto de factura → renglones, con Claude)
    aliases, auditoría)    └─ contabilium-worker (drena la cola → escribe en Contabilium)
                                     │
                                     ▼
                               Contabilium  ──nativo──►  Mercado Libre / Tienda Nube
```

Regla clave: **solo el worker escribe en Contabilium**, procesando la cola de a
poco, porque Contabilium limita a 25 peticiones cada 10 segundos por IP y no
tiene ambiente de pruebas (todo es producción).

## Estructura del repo

```
web/                      Panel React + Vite (corre en modo demo sin backend)
supabase/
  migrations/             Esquema (0001 tablas, 0002 RLS, 0003 funciones)
  seed.sql                Los 4 depósitos + SKUs de ejemplo
  functions/              Edge Functions (Deno/TypeScript)
scripts/test-contabilium.mjs   Sondeo de solo lectura de la API
docs/                     Relevamiento, contexto de negocio y diseño
```

## Puesta en marcha

### 0) Probar el panel ya (modo demo, riesgo cero)

```bash
cd web
npm install
npm run dev
```

Sin variables de entorno arranca en **modo demo** con datos de ejemplo: se ve el
panel, el ingreso por foto, el movimiento y las devoluciones funcionando, sin
tocar nada real. Ideal para mostrárselo a Martín, Tomás y Javier.

### 1) Sondear Contabilium (solo lectura)

```bash
cp .env.example .env      # completá CONTABILIUM_CLIENT_ID (email) y _SECRET (API Key)
node --env-file=.env scripts/test-contabilium.mjs
```

Valida el token, muestra qué endpoints responden y lista tus depósitos (con IDs)
y productos. **Los IDs de depósito son el dato que falta para todo lo demás.**

### 2) Crear el proyecto Supabase y aplicar el esquema

1. Crear un proyecto (free tier alcanza para empezar).
2. Aplicar las migraciones y el seed (SQL Editor, en orden): `0001_init.sql`,
   `0002_rls.sql`, `0003_functions.sql`, `seed.sql`.
3. Completar los `cb_deposito_id` de la tabla `depositos` con los IDs reales que
   devolvió el paso 1, por ejemplo:
   ```sql
   update depositos set cb_deposito_id = '123' where codigo = 'GEN';
   ```

### 3) Configurar y deployar las Edge Functions

Con la [CLI de Supabase](https://supabase.com/docs/guides/cli):

```bash
supabase link --project-ref <TU_REF>
supabase secrets set \
  CONTABILIUM_CLIENT_ID=... CONTABILIUM_CLIENT_SECRET=... \
  ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-sonnet-5
supabase functions deploy stock-sync contabilium-worker ocr-ingreso acciones
```

(`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase solo.)

Programar por cron (Dashboard → Edge Functions → Schedules):
- `stock-sync` cada 10-15 min (mantiene el espejo al día).
- `contabilium-worker` cada 1-2 min (drena la cola respetando el rate limit).

### 4) Conectar el panel

```bash
cd web
cp .env.example .env       # completá VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY
npm run dev                # o: npm run build  (deploy en Vercel)
```

El header pasa de «Modo demo» a «Conectado» y el panel muestra tu stock real.

## Testing seguro (sin sandbox — todo es producción)

1. **Espejo, unos días.** Solo `stock-sync` + panel en modo lectura. Confirmar
   que los números coinciden con Contabilium.
2. **Producto de prueba.** Un SKU `TEST-CENTRO-STOCK` para probar ingreso por
   foto y movimiento entre depósitos.
3. **En vivo.** Facturas reales y remitos automáticos.
4. **Devoluciones con nota de crédito al final**, y la primera validada con el
   contador (Claudio).

## Pendientes conocidos

- Endpoints de Contabilium marcados `[VERIFICAR]` en
  `supabase/functions/_shared/contabilium.ts`: confirmar sus rutas y forma con el
  sondeo del paso 1 o consultando a `api@contabilium.com`. Son variables de
  entorno (`CB_EP_*`), se ajustan sin tocar código.
- Autenticación del equipo (Supabase Auth / magic link) y matriz de permisos
  (ej. ocultar costos a ciertos roles): ver `docs`.
