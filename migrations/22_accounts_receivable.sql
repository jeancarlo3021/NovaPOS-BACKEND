-- Créditos por cliente + Cuentas por cobrar (CxC)

-- 1) Crédito por cliente
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_limit   NUMERIC  NOT NULL DEFAULT 0;

-- 2) Cuentas por cobrar
CREATE TABLE IF NOT EXISTS accounts_receivable (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  customer_id    UUID,
  customer_name  TEXT,
  invoice_id     UUID,
  invoice_number TEXT,
  total_amount   NUMERIC NOT NULL DEFAULT 0,
  paid_amount    NUMERIC NOT NULL DEFAULT 0,
  due_date       DATE,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | partial | paid | overdue
  source         TEXT NOT NULL DEFAULT 'manual',   -- pos | manual | distribution
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ar_tenant      ON accounts_receivable (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ar_customer    ON accounts_receivable (customer_id);
CREATE INDEX IF NOT EXISTS idx_ar_status      ON accounts_receivable (tenant_id, status);

-- 3) Abonos (historial de pagos de una cuenta por cobrar)
CREATE TABLE IF NOT EXISTS accounts_receivable_payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  receivable_id  UUID NOT NULL REFERENCES accounts_receivable(id) ON DELETE CASCADE,
  amount         NUMERIC NOT NULL,
  method         TEXT NOT NULL DEFAULT 'cash',     -- cash | card | sinpe
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_arp_receivable ON accounts_receivable_payments (receivable_id);
