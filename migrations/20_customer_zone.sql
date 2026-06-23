-- Zona del cliente (para filtrar en Distribución).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS zone TEXT;
CREATE INDEX IF NOT EXISTS idx_customers_zone ON customers(tenant_id, zone);
