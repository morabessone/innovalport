-- ============================================================================
-- Centro de Stock — esquema inicial
-- ----------------------------------------------------------------------------
-- Contabilium es la fuente de verdad del stock. Estas tablas son:
--   1) un ESPEJO de solo lectura del catálogo y el stock de Contabilium
--      (productos, stock, depositos), que la función stock-sync mantiene al día;
--   2) la CAPA OPERATIVA propia que Contabilium no tiene: cola de escritura,
--      remitos, pipeline de devoluciones, alias de SKU que aprende el OCR,
--      pérdidas valorizadas y auditoría.
--
-- Todas las escrituras hacia Contabilium pasan por la tabla cb_queue y las
-- procesa un único worker, para respetar el límite de 25 req / 10 s por IP.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Depósitos
-- ---------------------------------------------------------------------------
create table if not exists depositos (
  id             uuid primary key default gen_random_uuid(),
  codigo         text not null unique,          -- GEN, FLX, FULL, OFI
  nombre         text not null,
  cb_deposito_id text,                          -- id del depósito en Contabilium
  es_full        boolean not null default false,-- depósito de Mercado Libre Full
  sincroniza_ml  boolean not null default false,-- ¿es el que empuja stock a ML?
  orden          int not null default 0,
  activo         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Productos (espejo del catálogo de Contabilium)
-- ---------------------------------------------------------------------------
create table if not exists productos (
  id             uuid primary key default gen_random_uuid(),
  sku            text not null unique,
  nombre         text not null default '',
  cb_producto_id text,
  costo          numeric(14,2),
  precio         numeric(14,2),
  stock_minimo   int not null default 0,        -- umbral de reposición por SKU
  activo         boolean not null default true,
  updated_at     timestamptz not null default now()
);
create index if not exists productos_sku_idx on productos (lower(sku));

-- ---------------------------------------------------------------------------
-- Stock por depósito (espejo)
-- ---------------------------------------------------------------------------
create table if not exists stock (
  producto_id  uuid not null references productos(id) on delete cascade,
  deposito_id  uuid not null references depositos(id) on delete cascade,
  cantidad     int not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (producto_id, deposito_id)
);

-- ---------------------------------------------------------------------------
-- Alias de SKU: el OCR aprende que "cámara wifi ptz" en la factura de Maty
-- corresponde al SKU CAM-WIFI-PORT.
-- ---------------------------------------------------------------------------
create table if not exists sku_aliases (
  id          uuid primary key default gen_random_uuid(),
  alias       text not null,
  producto_id uuid not null references productos(id) on delete cascade,
  fuente      text not null default 'ocr',      -- ocr | manual
  created_at  timestamptz not null default now(),
  unique (lower(alias), producto_id)
);
create index if not exists sku_aliases_alias_idx on sku_aliases (lower(alias));

-- ---------------------------------------------------------------------------
-- Remitos: TODO movimiento físico genera uno. "Un movimiento, un registro."
-- ---------------------------------------------------------------------------
create table if not exists remitos (
  id                  uuid primary key default gen_random_uuid(),
  numero_int          bigint generated always as identity,
  tipo                text not null,   -- ingreso | movimiento | egreso | devolucion_retiro
  origen_deposito_id  uuid references depositos(id),
  destino_deposito_id uuid references depositos(id),
  estado              text not null default 'emitido', -- emitido | sincronizado | anulado
  cb_remito_id        text,            -- id del remito en Contabilium, si aplica
  ref_tabla           text,            -- ingresos | devoluciones | null
  ref_id              uuid,
  nota                text,
  created_by          text,
  created_at          timestamptz not null default now()
);
create index if not exists remitos_created_idx on remitos (created_at desc);

create table if not exists remito_items (
  id          uuid primary key default gen_random_uuid(),
  remito_id   uuid not null references remitos(id) on delete cascade,
  producto_id uuid references productos(id),
  sku_texto   text,                    -- por si aún no matchea a un producto
  cantidad    int not null check (cantidad > 0)
);

-- ---------------------------------------------------------------------------
-- Ingresos (por foto de factura/remito). El OCR llena ingreso_items;
-- al confirmar se genera el remito de ingreso y se encola el alta en Contabilium.
-- ---------------------------------------------------------------------------
create table if not exists ingresos (
  id                  uuid primary key default gen_random_uuid(),
  tipo                text not null default 'local',  -- impo | local
  proveedor           text,
  comprobante_url     text,            -- foto/pdf de la factura
  deposito_destino_id uuid references depositos(id),
  estado              text not null default 'borrador', -- borrador | confirmado
  ocr_json            jsonb,
  created_by          text,
  created_at          timestamptz not null default now(),
  confirmado_at       timestamptz
);

create table if not exists ingreso_items (
  id             uuid primary key default gen_random_uuid(),
  ingreso_id     uuid not null references ingresos(id) on delete cascade,
  sku_detectado  text,
  descripcion    text,
  producto_id    uuid references productos(id),
  cantidad       int not null default 1 check (cantidad > 0),
  costo_unit     numeric(14,2),
  confianza      numeric(4,3) not null default 0,  -- 0..1 (OCR)
  confirmado     boolean not null default false
);

-- ---------------------------------------------------------------------------
-- Devoluciones. Pipeline: cargada → retiro_generado → en_oficina →
-- apta (alta sin compra + nota de crédito) | no_apta (baja + pérdida).
-- ---------------------------------------------------------------------------
create table if not exists devoluciones (
  id                   uuid primary key default gen_random_uuid(),
  sku                  text,
  producto_id          uuid references productos(id),
  cantidad             int not null default 1 check (cantidad > 0),
  canal                text,           -- ML | TN
  venta_ref            text,           -- nro de venta / comprobante origen
  motivo               text,
  estado               text not null default 'cargada',
    -- cargada | retiro_generado | en_oficina | apta | no_apta
  deposito_origen_id   uuid references depositos(id),  -- Genpol (Full) o Flexit (Flex)
  deposito_destino_id  uuid references depositos(id),  -- a dónde reingresa si es apta
  apta                 boolean,
  valor_perdida        numeric(14,2),
  nota_credito_cb_id   text,
  decidido_por         text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists devoluciones_estado_idx on devoluciones (estado, created_at desc);

-- ---------------------------------------------------------------------------
-- Cola única hacia Contabilium (respeta el rate limit vía el worker)
-- ---------------------------------------------------------------------------
create table if not exists cb_queue (
  id           uuid primary key default gen_random_uuid(),
  accion       text not null,   -- ajuste_stock | crear_remito | nota_credito | ...
  payload      jsonb not null default '{}'::jsonb,
  estado       text not null default 'pendiente', -- pendiente | procesando | ok | error
  intentos     int not null default 0,
  ultimo_error text,
  ref_tabla    text,
  ref_id       uuid,
  created_at   timestamptz not null default now(),
  procesado_at timestamptz
);
create index if not exists cb_queue_pendientes_idx
  on cb_queue (created_at) where estado in ('pendiente','error');

-- ---------------------------------------------------------------------------
-- Auditoría
-- ---------------------------------------------------------------------------
create table if not exists auditoria (
  id         uuid primary key default gen_random_uuid(),
  entidad    text not null,
  entidad_id uuid,
  accion     text not null,
  detalle    jsonb,
  actor      text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Sincronización: última corrida de cada job (para el "en vivo" del panel)
-- ---------------------------------------------------------------------------
create table if not exists sync_estado (
  job        text primary key,     -- catalogo | stock
  ultima_ok  timestamptz,
  detalle    jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Vista consolidada de stock (lo que muestra el Panel)
-- ---------------------------------------------------------------------------
create or replace view v_stock_consolidado as
select
  p.id                                   as producto_id,
  p.sku,
  p.nombre,
  p.stock_minimo,
  p.activo,
  coalesce(sum(s.cantidad), 0)::int      as total,
  coalesce(
    jsonb_object_agg(d.codigo, s.cantidad) filter (where d.codigo is not null),
    '{}'::jsonb
  )                                      as por_deposito,
  case
    when coalesce(sum(s.cantidad), 0) <= 0 then 'sin_stock'
    when coalesce(sum(s.cantidad), 0) <= p.stock_minimo then 'reponer'
    else 'ok'
  end                                    as estado
from productos p
left join stock s on s.producto_id = p.id
left join depositos d on d.id = s.deposito_id
group by p.id;

-- trigger para updated_at en devoluciones
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists devoluciones_touch on devoluciones;
create trigger devoluciones_touch before update on devoluciones
  for each row execute function touch_updated_at();
