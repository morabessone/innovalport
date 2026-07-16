-- Ventas ingestadas desde Contabilium (comprobantes de ML + TN) — cierra el loop.
create table if not exists cb_ventas (
  cb_id bigint primary key,
  numero text,
  fecha timestamptz,
  origen text,               -- MercadoLibre | TiendaNube | ...
  inventario_cb bigint,      -- id de depósito de Contabilium
  items jsonb,               -- [{sku, cantidad}]
  aplicado boolean default false,
  procesado_at timestamptz default now()
);
alter table cb_ventas enable row level security;
drop policy if exists cb_ventas_read on cb_ventas;
create policy cb_ventas_read on cb_ventas for select using (true);

-- Mapeo depósito de Contabilium (Inventario) -> depósito de la app (GEN/FULL/FLX/OFI).
-- 113649 = Full (confirmado: 105/106 líneas vendidas son productos Full).
create table if not exists cb_inventario_map (
  inventario_cb bigint primary key,
  deposito_codigo text,
  nombre text
);
alter table cb_inventario_map enable row level security;
drop policy if exists cb_inv_read on cb_inventario_map;
create policy cb_inv_read on cb_inventario_map for select using (true);

insert into sync_estado(job, ultima_ok) values ('ventas', null)
on conflict (job) do nothing;
