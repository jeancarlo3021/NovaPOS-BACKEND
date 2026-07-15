-- Ventas por DELIVERY: no se suman al cierre de caja (se contabilizan aparte).
-- `delivery_commission_pct` = % que la plataforma/servicio descuenta del total.
-- `delivery_net` = total menos esa comisión (neto que recibe el negocio).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_delivery              BOOLEAN DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS delivery_commission_pct  NUMERIC DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS delivery_net             NUMERIC;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS delivery_platform        TEXT;   -- Uber / Didi / PedidosYa / Otro

CREATE INDEX IF NOT EXISTS idx_invoices_delivery ON invoices (tenant_id, is_delivery, issued_at);
