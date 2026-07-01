-- Actividad económica del cliente (para el receptor en Factura Electrónica).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS economic_activity_code TEXT;
