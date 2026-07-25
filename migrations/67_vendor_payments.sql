-- Pagos de proveedores de la PLATAFORMA (ColónClick): hosting, Alanube, WhatsApp,
-- etc. Registro interno del Panel Admin (no es por tenant — es global de la plataforma).
CREATE TABLE IF NOT EXISTS vendor_payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor      TEXT NOT NULL,                       -- proveedor
  concept     TEXT,                                -- concepto / descripción
  amount      NUMERIC(14,2) NOT NULL DEFAULT 0,    -- monto
  currency    TEXT NOT NULL DEFAULT 'CRC',         -- CRC | USD
  due_date    DATE,                                -- fecha de vencimiento
  paid        BOOLEAN NOT NULL DEFAULT FALSE,      -- pagado / pendiente
  paid_date   DATE,                                -- fecha en que se pagó
  recurring   TEXT,                                -- NULL | 'monthly' | 'yearly'
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Búsquedas típicas: por vencimiento y por estado.
CREATE INDEX IF NOT EXISTS idx_vendor_payments_due    ON vendor_payments (due_date);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_paid   ON vendor_payments (paid);
