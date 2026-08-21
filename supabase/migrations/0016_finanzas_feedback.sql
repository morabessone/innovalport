-- Feedback financiero (Martín + agregados): desglose de costos por canal,
-- envío Flex manual por SKU, condición de pago libre y parámetros de costo
-- adicionales (percepciones, gasto TN aproximado, financiación MP, envío Full).

-- Parámetros por producto: envío Flex manual + etiqueta de condición de pago
-- libre ("Otra") + canal principal declarado.
alter table producto_finanzas add column if not exists envio_flex numeric default 0;
alter table producto_finanzas add column if not exists condicion_pago_label text;
alter table producto_finanzas add column if not exists canal_principal text;

-- Config de cálculo: buckets de costo que hoy no venían de una API.
--   percepciones_pct     -> % de percepciones/AFIP sobre la venta bruta (ML).
--   financiacion_mp_pct  -> % de financiación de Mercado Pago (si aplica, ML).
--   tn_gasto_pct         -> gasto total APROXIMADO de Tienda Nube (sin API).
--   envio_full_default   -> costo de envío Full por unidad cuando no hay dato real.
alter table finanzas_config add column if not exists percepciones_pct numeric default 0;
alter table finanzas_config add column if not exists financiacion_mp_pct numeric default 0;
alter table finanzas_config add column if not exists tn_gasto_pct numeric default 0.15;
alter table finanzas_config add column if not exists envio_full_default numeric default 0;
