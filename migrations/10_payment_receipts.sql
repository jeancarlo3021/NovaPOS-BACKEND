-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 10: Comprobantes de pago de tenants
-- ═══════════════════════════════════════════════════════════════════════════
-- Registra los pagos que cada negocio hace al SaaS, separando:
--   - 'subscription' = plan corriente del software
--   - 'invoicing'    = plan de facturación electrónica

CREATE TABLE IF NOT EXISTS public.payment_receipts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('subscription', 'invoicing')),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  payment_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  period_start    DATE,
  period_end      DATE,
  payment_method  TEXT,              -- cash, transfer, sinpe, card, other
  reference       TEXT,              -- nº de comprobante, SINPE, etc.
  notes           TEXT,
  file_url        TEXT,              -- URL del comprobante en Storage (opcional)
  created_by      UUID,              -- userId admin que registró
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_receipts_tenant
  ON public.payment_receipts(tenant_id, payment_date DESC);

CREATE INDEX IF NOT EXISTS idx_payment_receipts_type
  ON public.payment_receipts(type, payment_date DESC);

-- RLS: solo lectura tenant-scope; el panel admin usa service role.
ALTER TABLE public.payment_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_receipts_tenant_read ON public.payment_receipts;
CREATE POLICY payment_receipts_tenant_read ON public.payment_receipts
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id());

NOTIFY pgrst, 'reload schema';
