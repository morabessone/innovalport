-- ============================================================================
-- Row Level Security
-- ----------------------------------------------------------------------------
-- Modelo de acceso:
--   * El frontend usa la ANON key solo para LEER catálogo, stock, remitos,
--     devoluciones e ingresos (datos operativos no sensibles del negocio).
--   * TODA escritura pasa por las Edge Functions, que usan la SERVICE ROLE key
--     (bypassea RLS). Así las credenciales de Contabilium y la lógica de la cola
--     viven solo en el servidor, y el navegador nunca escribe directo.
--
-- Cuando sumemos Supabase Auth (magic link para el equipo), se puede endurecer
-- para exigir authenticated en los SELECT y ocultar costos/precios a ciertos
-- roles (ver matriz de permisos en docs). Por ahora priorizamos poder probar.
-- ============================================================================

alter table depositos     enable row level security;
alter table productos     enable row level security;
alter table stock         enable row level security;
alter table sku_aliases   enable row level security;
alter table remitos       enable row level security;
alter table remito_items  enable row level security;
alter table ingresos      enable row level security;
alter table ingreso_items enable row level security;
alter table devoluciones  enable row level security;
alter table cb_queue      enable row level security;
alter table auditoria     enable row level security;
alter table sync_estado   enable row level security;

-- Lectura para anon + authenticated en las tablas operativas.
do $$
declare t text;
begin
  foreach t in array array[
    'depositos','productos','stock','sku_aliases','remitos','remito_items',
    'ingresos','ingreso_items','devoluciones','sync_estado'
  ] loop
    execute format(
      'drop policy if exists %I on %I;', 'read_'||t, t);
    execute format(
      'create policy %I on %I for select to anon, authenticated using (true);',
      'read_'||t, t);
  end loop;
end $$;

-- cb_queue y auditoria: NO se exponen a anon (contienen payloads internos).
-- Solo la service role (edge functions) las toca; sin políticas = sin acceso
-- para anon/authenticated, que es lo que queremos.
