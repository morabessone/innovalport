-- ============================================================================
-- Datos semilla
-- ----------------------------------------------------------------------------
-- Los 4 depósitos reales de Innovalport. Los cb_deposito_id quedan NULL hasta
-- correr scripts/test-contabilium.mjs, que lista los depósitos de Contabilium
-- con sus IDs reales; ahí se completan con un update.
--
-- Los productos NO se siembran a mano: los trae stock-sync desde Contabilium.
-- Se deja un puñado de SKUs de ejemplo (los del core del negocio) SOLO para
-- poder ver el panel antes de la primera sincronización; stock-sync los va a
-- pisar/actualizar con los datos reales por su SKU.
-- ============================================================================

insert into depositos (codigo, nombre, es_full, sincroniza_ml, orden) values
  ('GEN',  'Genpol (Don Torcuato)',    false, false, 1),
  ('FLX',  'Flexit (envíos Flex)',     false, false, 2),
  ('FULL', 'Full (Mercado Libre)',     true,  true,  3),
  ('OFI',  'Oficina',                  false, false, 4)
on conflict (codigo) do nothing;

insert into productos (sku, nombre, stock_minimo) values
  ('INODORO-INTEL-PORT',  'Inodoro inteligente',   5),
  ('BACHA-INTEL-PORT',    'Bacha inteligente',     5),
  ('DUCHAPROPIO-PORT',    'Duchador inteligente',  8),
  ('CAM-WIFI-PORT',       'Cámara de seguridad wifi', 10)
on conflict (sku) do nothing;
