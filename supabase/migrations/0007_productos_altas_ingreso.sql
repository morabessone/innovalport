-- Soporte de alta de productos desde Ingreso (existente / nuevo / variante).
-- base_sku: para variantes, el SKU del producto padre.
-- cb_pendiente: producto creado en la app que todavía NO existe en Contabilium
--   (cuando se active el write-back, hay que crearlo allá).
alter table productos add column if not exists base_sku text;
alter table productos add column if not exists cb_pendiente boolean default false;
