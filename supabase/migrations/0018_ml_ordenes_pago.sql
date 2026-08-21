-- Acreditación de Mercado Libre / Mercado Pago.
-- El dato REAL de acreditación se trae de api.mercadopago.com/v1/payments/{id}
-- (money_release_date / money_release_status / net_received_amount). El token de
-- ML del vendedor tiene acceso a sus propios pagos ahí (no hace falta un login
-- extra de MP). dias_acreditacion_ml queda como respaldo (estimación por
-- antigüedad) para las órdenes que todavía no se enriquecieron con MP.
alter table ml_ordenes add column if not exists payment_id bigint;
alter table ml_ordenes add column if not exists money_release_status text;
alter table ml_ordenes add column if not exists neto_recibido numeric;

-- Días típicos hasta que Mercado Pago libera el dinero de una venta (respaldo /
-- estimación cuando aún no hay dato real de MP para la orden).
alter table finanzas_config add column if not exists dias_acreditacion_ml integer default 7;
