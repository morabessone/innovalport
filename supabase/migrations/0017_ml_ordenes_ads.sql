-- Integración de Mercado Libre a nivel venta: acreditación (capital disponible
-- vs. pendiente), costo real de envío/logística y comisión real por venta; más
-- la inversión de Mercado Ads (Product Ads) por publicación/SKU.

-- Órdenes de ML. Una fila por (orden, publicación). Alimenta:
--   · capital disponible (acreditado) vs. pendiente de acreditar,
--   · logística real (envio_costo) para el desglose de costos,
--   · comisión real por venta (sale_fee).
create table if not exists ml_ordenes (
  order_id     bigint  not null,
  ml_item_id   text    not null,
  sku          text,
  fecha        timestamptz,
  cantidad     numeric default 0,
  monto        numeric default 0,          -- total cobrado al comprador (ítem)
  sale_fee     numeric default 0,          -- comisión real de ML de la venta
  envio_costo  numeric default 0,          -- costo de logística al vendedor
  logistic_type text,
  pago_estado  text,                       -- approved / pending / in_process / ...
  acreditado   boolean default false,      -- money_release_date <= ahora
  fecha_acreditacion timestamptz,          -- money_release_date de MP
  shipment_id  bigint,
  updated_at   timestamptz default now(),
  primary key (order_id, ml_item_id)
);
alter table ml_ordenes enable row level security;
create policy read_ml_ordenes on ml_ordenes for select to anon, authenticated using (true);
create index if not exists ml_ordenes_sku_idx on ml_ordenes (sku);
create index if not exists ml_ordenes_fecha_idx on ml_ordenes (fecha);

-- Inversión publicitaria (Mercado Ads / Product Ads) por publicación, por ventana.
create table if not exists ml_ads (
  ml_item_id   text    not null,
  periodo_dias integer not null default 30,
  sku          text,
  cost         numeric default 0,          -- inversión en $
  clicks       numeric default 0,
  prints       numeric default 0,
  acos         numeric,
  roas         numeric,
  units        numeric default 0,          -- unidades atribuidas
  amount       numeric default 0,          -- venta atribuida
  updated_at   timestamptz default now(),
  primary key (ml_item_id, periodo_dias)
);
alter table ml_ads enable row level security;
create policy read_ml_ads on ml_ads for select to anon, authenticated using (true);
create index if not exists ml_ads_sku_idx on ml_ads (sku);
