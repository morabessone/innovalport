-- Integración Flexit (envío Flex / pool físico). Trae el costo REAL de envío
-- cobrado por entrega (GET /api/entregas) — lo que Martín pedía como "cuánto se
-- cobró de envío" — y permite cotizar on-demand (POST /api/cotizacion).
-- Credenciales del cliente Flexit en canal_config tipo='flexit'
-- (client_id = usuario, client_secret = password).

create table if not exists flexit_entregas (
  nro_venta   text primary key,     -- identificador de la venta en el conector (ML/TN)
  costo       numeric default 0,     -- costo REAL de la entrega cobrado por Flexit
  zona        text,
  estado      text,
  direccion   text,
  fecha       timestamptz,
  codinterno  text,
  nro_guia    text,
  sku         text,                  -- resuelto por join nro_venta -> ml_ordenes (best effort)
  updated_at  timestamptz default now()
);
alter table flexit_entregas enable row level security;
create policy read_flexit_entregas on flexit_entregas for select to anon, authenticated using (true);
create index if not exists flexit_entregas_sku_idx on flexit_entregas (sku);
create index if not exists flexit_entregas_fecha_idx on flexit_entregas (fecha);
