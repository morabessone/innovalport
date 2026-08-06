-- Reservas por depósito (StockReservado de Contabilium). Disponible = cantidad - reservado.
alter table stock add column if not exists reservado integer not null default 0;

-- Recrear la vista agregando 'reservas' AL FINAL (Postgres no deja reordenar columnas).
drop view if exists v_stock_canales;
create view v_stock_canales as
select
  p.id as producto_id, p.sku, p.nombre, p.activo,
  coalesce(p.tipo, 'P') as tipo, p.stock_minimo, p.costo,
  coalesce((select sum(s.cantidad) from stock s where s.producto_id = p.id), 0)::integer as total,
  coalesce((select jsonb_object_agg(d.codigo, s.cantidad) from stock s join depositos d on d.id = s.deposito_id where s.producto_id = p.id), '{}'::jsonb) as por_deposito,
  coalesce((select jsonb_object_agg(cs.canal, cs.publicado) from canal_stock cs where cs.producto_id = p.id), '{}'::jsonb) as por_canal,
  coalesce((select jsonb_object_agg(d.codigo, s.reservado) from stock s join depositos d on d.id = s.deposito_id where s.producto_id = p.id and s.reservado <> 0), '{}'::jsonb) as reservas
from productos p;
