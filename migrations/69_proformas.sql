-- Proformas (cotizaciones): documento NO fiscal que luego se puede pasar a venta
-- en el POS (corriente o electrónico). Guarda cliente + items + totales.
CREATE TABLE IF NOT EXISTS proformas (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  number                  TEXT,                                -- consecutivo PRO-000001
  customer_id             UUID,
  customer_name           TEXT,
  customer_identification TEXT,
  -- items: [{ product_id, name, sku, quantity, unit_price, iva_rate, cabys, unit }]
  items                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal                NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax                     NUMERIC(14,2) NOT NULL DEFAULT 0,
  total                   NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes                   TEXT,
  valid_until             DATE,                                -- vigencia de la cotización
  status                  TEXT NOT NULL DEFAULT 'open',        -- open | converted | cancelled
  converted_invoice       TEXT,                                -- n° de factura al pasarse a venta
  created_by              UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proformas_tenant_status ON proformas (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_proformas_created        ON proformas (tenant_id, created_at DESC);
