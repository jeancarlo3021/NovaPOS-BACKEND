-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 06: Tabla stock_adjustments
-- ═══════════════════════════════════════════════════════════════════════════
-- Registra TODOS los ajustes manuales de stock con motivo trazable.
-- Aparece en el reporte de stock.

CREATE TABLE IF NOT EXISTS public.stock_adjustments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  product_id   UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email   TEXT,                       -- snapshot del email del cajero
  type         TEXT NOT NULL CHECK (type IN ('increase','decrease','set','damage','expired','theft','return','count')),
  quantity     NUMERIC(12, 3) NOT NULL,    -- diferencia aplicada (puede ser negativa)
  stock_before NUMERIC(12, 3) NOT NULL,
  stock_after  NUMERIC(12, 3) NOT NULL,
  reason       TEXT NOT NULL,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para queries del reporte
CREATE INDEX IF NOT EXISTS idx_stock_adj_tenant_date
  ON public.stock_adjustments(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_adj_product
  ON public.stock_adjustments(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_adj_type
  ON public.stock_adjustments(tenant_id, type);

-- RLS
ALTER TABLE public.stock_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_adj_select" ON public.stock_adjustments;
DROP POLICY IF EXISTS "stock_adj_insert" ON public.stock_adjustments;

CREATE POLICY "stock_adj_select" ON public.stock_adjustments
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY "stock_adj_insert" ON public.stock_adjustments
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

NOTIFY pgrst, 'reload schema';
