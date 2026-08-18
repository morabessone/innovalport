-- Publicaciones de Mercado Libre: espejo de LECTURA + lógica de precio/alertas.
create table if not exists publicaciones (
  ml_item_id text primary key,
  sku text,
  producto_id uuid references productos(id) on delete set null,
  titulo text,
  categoria_id text,
  category_name text,
  estado text,
  precio numeric,
  moneda text default 'ARS',
  available_quantity int default 0,
  sold_quantity int default 0,
  health numeric,
  listing_type_id text,
  logistic_type text,
  permalink text,
  thumbnail text,
  is_catalog boolean default false,
  catalog_product_id text,
  catalog jsonb default '{}'::jsonb,     -- price_to_win, ganando, precio ganador
  costo numeric,                          -- snapshot de Contabilium
  precio_min numeric,                     -- piso rentable calculado
  margen_pct numeric,                     -- margen neto al precio actual
  sugerencia jsonb default '{}'::jsonb,   -- {accion, precio_sugerido, motivo, margen}
  alertas jsonb default '[]'::jsonb,      -- [{tipo, nivel, texto}]
  atributos jsonb default '[]'::jsonb,
  metrics jsonb default '{}'::jsonb,      -- {visitas, conversion, ...}
  raw jsonb,
  updated_at timestamptz default now()
);
create index if not exists publicaciones_sku_idx on publicaciones(sku);
create index if not exists publicaciones_producto_idx on publicaciones(producto_id);

-- Sugerencias de alta (Pendientes): productos de Contabilium sin publicación.
create table if not exists publicacion_sugerencias (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid references productos(id) on delete cascade,
  sku text,
  titulo_sugerido text,
  descripcion_sugerida text,
  categoria_sugerida text,
  atributos jsonb default '[]'::jsonb,
  imagenes jsonb default '[]'::jsonb,     -- referencias (catálogo ML), NUNCA se publican solas
  fuente_imagenes text,
  estado text default 'borrador',         -- borrador | descartada | publicada
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists publicacion_sugerencias_prod_idx on publicacion_sugerencias(producto_id);

alter table publicaciones enable row level security;
alter table publicacion_sugerencias enable row level security;
create policy read_publicaciones on publicaciones for select to anon, authenticated using (true);
create policy read_pub_sugerencias on publicacion_sugerencias for select to anon, authenticated using (true);

-- Que el login local (anon) también pueda leer el catálogo de productos.
do $$ begin
  if not exists (select 1 from pg_policy where polrelid='public.productos'::regclass and polname='read_productos_anon') then
    create policy read_productos_anon on productos for select to anon using (true);
  end if;
end $$;
