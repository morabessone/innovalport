-- Precisión del módulo financiero: montos reales, comisión real de ML y
-- parámetros financieros por producto.

-- Importe real por venta (Contabilium) — se llena en cb_ventas.items[].monto.
alter table cb_ventas add column if not exists total numeric;

-- Comisión REAL de ML por publicación (desde /sites/MLA/listing_prices).
alter table publicaciones add column if not exists comision_monto numeric;
alter table publicaciones add column if not exists comision_pct numeric;

-- Parámetros financieros por producto (editables desde el detalle; NO van a
-- Contabilium, solo alimentan el ciclo de caja).
create table if not exists producto_finanzas (
  producto_id uuid primary key references productos(id) on delete cascade,
  proveedor text,
  precio_compra numeric,
  condicion_pago_dias integer default 0,
  tasa_financiacion numeric default 0,
  updated_at timestamptz default now()
);
alter table producto_finanzas enable row level security;
create policy read_producto_finanzas on producto_finanzas for select to anon, authenticated using (true);
