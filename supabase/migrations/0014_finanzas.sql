-- Módulo financiero: compras con términos de pago + configuración.
create table if not exists compras_detalle (
  id uuid primary key default gen_random_uuid(),
  ingreso_id uuid references ingresos(id) on delete set null,
  producto_id uuid references productos(id) on delete set null,
  sku text,
  proveedor text,
  precio_unitario numeric default 0,
  cantidad integer default 0,
  fecha_compra date default current_date,
  condicion_pago_dias integer default 0,
  fecha_pago_programada date,
  fecha_pago_real date,
  tasa_financiacion numeric default 0,
  costo_logistica_compra numeric default 0,
  created_at timestamptz default now()
);
create index if not exists compras_detalle_sku_idx on compras_detalle(sku);
create index if not exists compras_detalle_prov_idx on compras_detalle(proveedor);
create index if not exists compras_detalle_fecha_idx on compras_detalle(fecha_compra);

create table if not exists finanzas_config (
  id int primary key default 1,
  tasa_anual numeric default 0.40,
  comision_ml numeric default 0.14,
  comision_tn numeric default 0.10,
  dias_cobro_ml integer default 14,
  dias_cobro_tn integer default 10,
  costo_envio_default numeric default 0,
  margen_min numeric default 0.15,
  updated_at timestamptz default now(),
  constraint finanzas_config_singleton check (id = 1)
);
insert into finanzas_config (id) values (1) on conflict (id) do nothing;

alter table compras_detalle enable row level security;
alter table finanzas_config enable row level security;
create policy read_compras on compras_detalle for select to anon, authenticated using (true);
create policy read_fin_config on finanzas_config for select to anon, authenticated using (true);

do $$ begin
  if not exists (select 1 from pg_policy where polrelid='public.cb_ventas'::regclass and polname='read_cb_ventas') then
    alter table cb_ventas enable row level security;
    create policy read_cb_ventas on cb_ventas for select to anon, authenticated using (true);
  end if;
end $$;
