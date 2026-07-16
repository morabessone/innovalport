-- Snapshot del stock por depósito para restaurar después de pruebas.
create table if not exists stock_snapshot (
  label text not null,
  producto_id uuid not null,
  deposito_id uuid not null,
  cantidad integer not null,
  snapshot_at timestamptz default now(),
  primary key (label, producto_id, deposito_id)
);

-- Restaura el stock desde un snapshot dado. Sobrescribe la tabla stock con los
-- valores del snapshot. No toca Contabilium.
create or replace function restaurar_snapshot(p_label text default 'conciliado_pre_pruebas')
returns integer language plpgsql security definer as $$
declare n integer;
begin
  update stock s set cantidad = ss.cantidad, updated_at = now()
  from stock_snapshot ss
  where ss.label = p_label and ss.producto_id = s.producto_id and ss.deposito_id = s.deposito_id;
  insert into stock (producto_id, deposito_id, cantidad, updated_at)
  select ss.producto_id, ss.deposito_id, ss.cantidad, now()
  from stock_snapshot ss
  where ss.label = p_label
    and not exists (select 1 from stock s where s.producto_id = ss.producto_id and s.deposito_id = ss.deposito_id);
  select count(*) into n from stock_snapshot where label = p_label;
  return n;
end $$;
