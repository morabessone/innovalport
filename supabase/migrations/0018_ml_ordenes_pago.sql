-- Acreditación de Mercado Libre / Mercado Pago.
-- El money_release_date real requiere scope de Mercado Pago (/v1/payments), que
-- hoy el token de ML no tiene. Mientras tanto se estima la acreditación por la
-- antigüedad de la orden (dias_acreditacion_ml). Estas columnas guardan el dato
-- real cuando se habilite el scope de MP.
alter table ml_ordenes add column if not exists payment_id bigint;
alter table ml_ordenes add column if not exists money_release_status text;
alter table ml_ordenes add column if not exists neto_recibido numeric;

-- Días típicos hasta que Mercado Pago libera el dinero de una venta (estimación
-- del capital disponible vs. pendiente cuando no hay dato real de MP).
alter table finanzas_config add column if not exists dias_acreditacion_ml integer default 7;
