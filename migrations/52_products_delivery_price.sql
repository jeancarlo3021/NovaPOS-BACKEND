-- Precio de venta ESPECÍFICO para delivery (distinto al precio de mesa/normal).
-- Si está en NULL o 0, el POS usa el precio normal (unit_price) también en delivery.
ALTER TABLE products ADD COLUMN IF NOT EXISTS delivery_price NUMERIC;
