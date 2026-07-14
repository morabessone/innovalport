-- Modo seguro (dry-run) para la escritura hacia Contabilium.
-- Con el dry-run activado (por defecto), el worker calcula exactamente qué
-- request enviaría a Contabilium y lo guarda en 'simulacion', SIN enviarlo.
-- Así se puede revisar y aprobar la escritura antes de tocar nada real.
alter table cb_queue add column if not exists simulacion jsonb;
alter table cb_queue add column if not exists simulado_at timestamptz;
