-- "Activa de verdad": status active y con stock actual o ventas en 90 días.
alter table publicaciones add column if not exists activa_real boolean default true;
alter table publicaciones add column if not exists vendidos_90 int default 0;
create index if not exists publicaciones_activa_real_idx on publicaciones(activa_real);
