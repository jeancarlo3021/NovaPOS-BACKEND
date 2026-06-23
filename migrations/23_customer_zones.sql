-- Zonas de clientes (lista administrable). El cliente guarda el nombre en customers.zone.
CREATE TABLE IF NOT EXISTS customer_zones (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_zones_unique ON customer_zones (tenant_id, lower(name));
