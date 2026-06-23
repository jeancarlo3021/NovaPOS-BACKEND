-- Método de pago que se registra al ENTREGAR un pedido de preventa.
ALTER TABLE route_orders ADD COLUMN IF NOT EXISTS payment_method TEXT;
