-- ============================================================================
-- Funciones de apoyo
-- ============================================================================

-- Ajusta el stock espejo de un producto en un depósito por un delta (+/-),
-- sin permitir negativos. Upsert atómico.
create or replace function ajustar_stock_espejo(
  p_producto uuid,
  p_deposito uuid,
  p_delta    int
) returns int language plpgsql as $$
declare nueva int;
begin
  insert into stock (producto_id, deposito_id, cantidad, updated_at)
  values (p_producto, p_deposito, greatest(0, p_delta), now())
  on conflict (producto_id, deposito_id)
  do update set
    cantidad   = greatest(0, stock.cantidad + p_delta),
    updated_at = now()
  returning cantidad into nueva;
  return nueva;
end $$;
