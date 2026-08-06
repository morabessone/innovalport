-- ============================================================================
-- Devoluciones v2
-- Nuevo circuito: En proceso (ML API) → Por retirar (clasificada GEN/FLX, con
-- los SKUs reales que informa ML) → Generar remito → En oficina → decidir por
-- SKU si es apta (vuelve al stock) o no apta (baja + pérdida).
-- Soporta también carga manual (Tienda Nube y cualquier caso sin API).
-- ============================================================================

-- --- Cabecera: columnas nuevas -------------------------------------------------
alter table devoluciones add column if not exists origen             text not null default 'manual';   -- ml_api | manual
alter table devoluciones add column if not exists ml_claim_id        text;   -- id del reclamo en Mercado Libre
alter table devoluciones add column if not exists ml_return_id       text;   -- id de la devolución/return en ML
alter table devoluciones add column if not exists ml_shipment_id     text;   -- envío de retorno
alter table devoluciones add column if not exists entregada_at       timestamptz;   -- cuando ML la marcó entregada
alter table devoluciones add column if not exists deposito_retiro_id uuid references depositos(id);     -- GEN o FLX de dónde se retira
alter table devoluciones add column if not exists remito_id          uuid references remitos(id);       -- remito de retiro generado

-- Estados posibles ahora:
--   en_proceso     -> devolución abierta en ML, mercadería todavía en tránsito
--   por_retirar    -> ML la marcó entregada; lista para retirar de GEN/FLX
--   en_oficina     -> se generó el remito, la mercadería está en Oficina
--   apta           -> todos los SKUs revisados y aptos (reingresan al stock)
--   no_apta        -> todos los SKUs dados de baja (pérdida)
--   parcial        -> mezcla de aptos y no aptos ya resuelta
comment on column devoluciones.estado is
  'en_proceso | por_retirar | en_oficina | apta | no_apta | parcial';

-- --- Ítems (SKUs reales de la devolución) --------------------------------------
-- Una devolución puede traer varios SKUs. Cada uno se decide por separado.
create table if not exists devolucion_items (
  id              uuid primary key default gen_random_uuid(),
  devolucion_id   uuid not null references devoluciones(id) on delete cascade,
  sku             text,
  producto_id     uuid references productos(id),
  cantidad        int not null default 1 check (cantidad > 0),
  apta            boolean,                 -- null = sin decidir
  destino_no_apta text,                    -- tirar | outlet | repuesto (si no apta)
  valor_perdida   numeric(14,2),           -- costo * cantidad si no apta
  decidido_por    text,
  decidido_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists devolucion_items_dev_idx on devolucion_items (devolucion_id);

alter table devolucion_items enable row level security;
do $$ begin
  create policy devolucion_items_all on devolucion_items for all
    using (true) with check (true);
exception when duplicate_object then null; end $$;

-- --- Backfill: cada devolución vieja de 1 SKU pasa a tener su ítem -------------
insert into devolucion_items (devolucion_id, sku, producto_id, cantidad, apta, destino_no_apta, valor_perdida)
select d.id, d.sku, d.producto_id, d.cantidad,
       case when d.estado = 'apta' then true when d.estado = 'no_apta' then false else null end,
       case when d.estado = 'no_apta' then coalesce(d.destino_no_apta, 'tirar') else null end,
       case when d.estado = 'no_apta' then d.valor_perdida else null end
from devoluciones d
where not exists (select 1 from devolucion_items di where di.devolucion_id = d.id);

-- Normaliza el estado viejo 'cargada'/'retiro_generado' al nuevo 'por_retirar'.
update devoluciones set estado = 'por_retirar'
where estado in ('cargada', 'retiro_generado');

-- Marca las viejas ya recibidas como en_oficina si aún no se decidieron.
-- (en_oficina, apta, no_apta se mantienen igual)
