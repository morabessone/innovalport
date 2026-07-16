-- Tipo de concepto de Contabilium en productos: 'P' producto, 'V' variante, 'C' combo.
alter table productos add column if not exists tipo text default 'P';

-- Combos: un SKU combo consume N unidades de un SKU base (SET X2/X3/X4).
-- Contabilium ya descuenta el base al vender el combo; esto es para mostrar/entender.
create table if not exists combos (
  combo_sku text primary key,
  base_sku  text not null,
  cantidad  integer not null default 1,
  updated_at timestamptz default now()
);
alter table combos enable row level security;
drop policy if exists combos_read on combos;
create policy combos_read on combos for select using (true);

-- v_stock_canales: expone tipo, stock_minimo y costo por producto, además del
-- stock por depósito (GEN/FULL/FLX/OFI) y lo publicado por canal (ml_full/ml_flex/tn).
drop view if exists v_stock_canales;
create view v_stock_canales as
select p.id as producto_id, p.sku, p.nombre, p.activo, coalesce(p.tipo,'P') as tipo, p.stock_minimo, p.costo,
  coalesce((select sum(s.cantidad) from stock s where s.producto_id=p.id),0)::integer as total,
  coalesce((select jsonb_object_agg(d.codigo, s.cantidad) from stock s join depositos d on d.id=s.deposito_id where s.producto_id=p.id),'{}'::jsonb) as por_deposito,
  coalesce((select jsonb_object_agg(cs.canal, cs.publicado) from canal_stock cs where cs.producto_id=p.id),'{}'::jsonb) as por_canal
from productos p;
