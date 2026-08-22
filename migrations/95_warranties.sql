-- 95 · Garantías.
--
-- El cliente vuelve con un producto malo y hoy eso se maneja de palabra: no hay
-- forma de saber si está en garantía, en qué anda el reclamo ni cuánto lleva
-- donde el proveedor. Esto le da número, estado y respaldo fotográfico.

ALTER TABLE public.products
  -- Meses de garantía del producto. 0 = sin garantía.
  ADD COLUMN IF NOT EXISTS warranty_months INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.warranties (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  number           TEXT,

  -- Venta de origen (snapshot: la factura puede anularse y el caso sigue).
  invoice_id       UUID,
  invoice_number   TEXT,
  sold_at          DATE,

  customer_id      UUID,
  customer_name    TEXT,
  customer_phone   TEXT,

  product_id       UUID,
  product_name     TEXT NOT NULL,
  serial           TEXT,
  quantity         NUMERIC(14,4) NOT NULL DEFAULT 1,

  -- Vigencia calculada al abrir el caso (meses del producto sobre la fecha de venta).
  warranty_until   DATE,
  /** true = se recibió fuera de garantía y se atiende igual (decisión del negocio). */
  out_of_warranty  BOOLEAN NOT NULL DEFAULT false,

  issue            TEXT NOT NULL,
  photos           JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- open | with_supplier | approved | rejected | resolved
  status           TEXT NOT NULL DEFAULT 'open',
  -- repair | replace | refund | credit | none
  resolution       TEXT,
  resolution_notes TEXT,

  supplier_id      UUID,
  supplier_ref     TEXT,
  sent_at          TIMESTAMPTZ,
  returned_at      TIMESTAMPTZ,
  closed_at        TIMESTAMPTZ,

  -- Bitácora: [{at, by, from, to, note}]
  events           JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS warranties_tenant_status
  ON public.warranties (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS warranties_customer
  ON public.warranties (tenant_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS warranties_invoice
  ON public.warranties (tenant_id, invoice_id) WHERE invoice_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
