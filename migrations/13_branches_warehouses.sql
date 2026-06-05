-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 13: Sucursales y Bodegas (Modelo B: empresa con sucursales)
-- ═══════════════════════════════════════════════════════════════════════════
-- Crea la base para multi-sucursal:
--   - branches            sucursales de la empresa
--   - warehouses          bodegas dentro de cada sucursal
--   - product_stock       stock por (producto, bodega)
--   - user_branches       asignación de usuarios a sucursales
--   - stock_transfers     transferencias entre bodegas
--   - stock_transfer_items
-- Y añade branch_id a las tablas operativas para gating futuro.
-- Hace backfill seguro: cada tenant queda con "Sucursal Principal" y
-- "Bodega Principal", y los datos existentes se atribuyen a esa sucursal.

-- ── 1. BRANCHES ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.branches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  name         TEXT NOT NULL,
  code         TEXT NOT NULL,                -- ej. "SUC01", usado en consecutivos
  address      TEXT,
  city         TEXT,
  phone        TEXT,
  hacienda_branch_code TEXT,                  -- código de sucursal en Hacienda CR
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  is_default   BOOLEAN NOT NULL DEFAULT FALSE, -- la principal del tenant
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_branches_tenant ON public.branches(tenant_id);

-- ── 2. WAREHOUSES ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.warehouses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  branch_id    UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  code         TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  is_default   BOOLEAN NOT NULL DEFAULT FALSE, -- bodega por defecto de la sucursal
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(branch_id, code)
);

CREATE INDEX IF NOT EXISTS idx_warehouses_tenant ON public.warehouses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_warehouses_branch ON public.warehouses(branch_id);

-- ── 3. PRODUCT_STOCK ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.product_stock (
  tenant_id    UUID NOT NULL,
  product_id   UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  quantity     NUMERIC NOT NULL DEFAULT 0,
  min_level    NUMERIC,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_product_stock_tenant     ON public.product_stock(tenant_id);
CREATE INDEX IF NOT EXISTS idx_product_stock_warehouse  ON public.product_stock(warehouse_id);

-- ── 4. USER_BRANCHES ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_branches (
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  branch_id  UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_user_branches_user ON public.user_branches(user_id);

-- ── 5. STOCK_TRANSFERS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stock_transfers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  from_warehouse  UUID NOT NULL REFERENCES public.warehouses(id),
  to_warehouse    UUID NOT NULL REFERENCES public.warehouses(id),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_transit','received','cancelled')),
  notes           TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  received_at     TIMESTAMPTZ,
  received_by     UUID
);

CREATE INDEX IF NOT EXISTS idx_transfers_tenant ON public.stock_transfers(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON public.stock_transfers(status, tenant_id);

CREATE TABLE IF NOT EXISTS public.stock_transfer_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id  UUID NOT NULL REFERENCES public.stock_transfers(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES public.products(id),
  quantity     NUMERIC NOT NULL CHECK (quantity > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfer_items_transfer ON public.stock_transfer_items(transfer_id);

-- ── 6. branch_id en tablas existentes (nullable hasta que el código lo use) ──
ALTER TABLE public.invoices         ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.branches(id);
ALTER TABLE public.cash_sessions    ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.branches(id);
ALTER TABLE public.expenses         ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.branches(id);
ALTER TABLE public.purchases        ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.branches(id);
ALTER TABLE public.purchases        ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES public.warehouses(id);
ALTER TABLE public.accounts_payable ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.branches(id);
ALTER TABLE public.stock_adjustments ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES public.warehouses(id);

CREATE INDEX IF NOT EXISTS idx_invoices_branch         ON public.invoices(branch_id);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_branch    ON public.cash_sessions(branch_id);
CREATE INDEX IF NOT EXISTS idx_expenses_branch         ON public.expenses(branch_id);
CREATE INDEX IF NOT EXISTS idx_purchases_branch        ON public.purchases(branch_id);
CREATE INDEX IF NOT EXISTS idx_purchases_warehouse     ON public.purchases(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_ap_branch               ON public.accounts_payable(branch_id);
CREATE INDEX IF NOT EXISTS idx_adjustments_warehouse   ON public.stock_adjustments(warehouse_id);

-- ── 7. Backfill: una "Sucursal Principal" + "Bodega Principal" por tenant ──
INSERT INTO public.branches (tenant_id, name, code, is_default)
SELECT t.id, 'Principal', 'SUC01', TRUE
FROM public.tenants t
WHERE NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.tenant_id = t.id);

INSERT INTO public.warehouses (tenant_id, branch_id, name, code, is_default)
SELECT b.tenant_id, b.id, 'Bodega Principal', 'BOD01', TRUE
FROM public.branches b
WHERE b.is_default = TRUE
  AND NOT EXISTS (SELECT 1 FROM public.warehouses w WHERE w.branch_id = b.id);

-- Asignar todos los usuarios existentes a la sucursal Principal de su tenant.
INSERT INTO public.user_branches (user_id, branch_id, is_default)
SELECT u.id, b.id, TRUE
FROM public.users u
JOIN public.branches b ON b.tenant_id = u.tenant_id AND b.is_default = TRUE
WHERE u.tenant_id IS NOT NULL
ON CONFLICT (user_id, branch_id) DO NOTHING;

-- Stock inicial: copiar products.stock_quantity a product_stock de la bodega Principal.
INSERT INTO public.product_stock (tenant_id, product_id, warehouse_id, quantity, min_level)
SELECT p.tenant_id, p.id, w.id,
       COALESCE(p.stock_quantity, 0),
       p.min_stock_level
FROM public.products p
JOIN public.branches  b ON b.tenant_id = p.tenant_id AND b.is_default = TRUE
JOIN public.warehouses w ON w.branch_id = b.id AND w.is_default = TRUE
ON CONFLICT (product_id, warehouse_id) DO NOTHING;

-- Atribuir todas las filas existentes a la sucursal Principal.
UPDATE public.invoices         SET branch_id = b.id
  FROM public.branches b
  WHERE b.tenant_id = invoices.tenant_id AND b.is_default = TRUE
    AND invoices.branch_id IS NULL;

UPDATE public.cash_sessions    SET branch_id = b.id
  FROM public.branches b
  WHERE b.tenant_id = cash_sessions.tenant_id AND b.is_default = TRUE
    AND cash_sessions.branch_id IS NULL;

UPDATE public.expenses         SET branch_id = b.id
  FROM public.branches b
  WHERE b.tenant_id = expenses.tenant_id AND b.is_default = TRUE
    AND expenses.branch_id IS NULL;

UPDATE public.purchases        SET branch_id = b.id, warehouse_id = w.id
  FROM public.branches b
  JOIN public.warehouses w ON w.branch_id = b.id AND w.is_default = TRUE
  WHERE b.tenant_id = purchases.tenant_id AND b.is_default = TRUE
    AND purchases.branch_id IS NULL;

UPDATE public.accounts_payable SET branch_id = b.id
  FROM public.branches b
  WHERE b.tenant_id = accounts_payable.tenant_id AND b.is_default = TRUE
    AND accounts_payable.branch_id IS NULL;

UPDATE public.stock_adjustments SET warehouse_id = w.id
  FROM public.branches b
  JOIN public.warehouses w ON w.branch_id = b.id AND w.is_default = TRUE
  WHERE b.tenant_id = stock_adjustments.tenant_id AND b.is_default = TRUE
    AND stock_adjustments.warehouse_id IS NULL;

-- ── 8. Trigger: mantener products.stock_quantity como suma de bodegas ──
-- Esto mantiene compat con todo el código actual hasta que se migren los
-- writes a product_stock. El número visible "global" sigue siendo correcto.
CREATE OR REPLACE FUNCTION public.sync_products_stock_total()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_product UUID;
  v_total   NUMERIC;
BEGIN
  v_product := COALESCE(NEW.product_id, OLD.product_id);
  SELECT COALESCE(SUM(quantity), 0) INTO v_total
    FROM public.product_stock
    WHERE product_id = v_product;
  UPDATE public.products SET stock_quantity = v_total WHERE id = v_product;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_product_stock_sync ON public.product_stock;
CREATE TRIGGER trg_product_stock_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.product_stock
  FOR EACH ROW EXECUTE FUNCTION public.sync_products_stock_total();

-- ── 9. RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.branches             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_stock        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_branches        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transfers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transfer_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS branches_tenant ON public.branches;
CREATE POLICY branches_tenant ON public.branches
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS warehouses_tenant ON public.warehouses;
CREATE POLICY warehouses_tenant ON public.warehouses
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS product_stock_tenant ON public.product_stock;
CREATE POLICY product_stock_tenant ON public.product_stock
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS user_branches_self ON public.user_branches;
CREATE POLICY user_branches_self ON public.user_branches
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.branches b WHERE b.id = branch_id AND b.tenant_id = public.current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.branches b WHERE b.id = branch_id AND b.tenant_id = public.current_tenant_id()));

DROP POLICY IF EXISTS transfers_tenant ON public.stock_transfers;
CREATE POLICY transfers_tenant ON public.stock_transfers
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS transfer_items_via_transfer ON public.stock_transfer_items;
CREATE POLICY transfer_items_via_transfer ON public.stock_transfer_items
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.stock_transfers t WHERE t.id = transfer_id AND t.tenant_id = public.current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.stock_transfers t WHERE t.id = transfer_id AND t.tenant_id = public.current_tenant_id()));

-- ── 10. Triggers updated_at ─────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_branches_updated ON public.branches;
CREATE TRIGGER trg_branches_updated
  BEFORE UPDATE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_warehouses_updated ON public.warehouses;
CREATE TRIGGER trg_warehouses_updated
  BEFORE UPDATE ON public.warehouses
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

NOTIFY pgrst, 'reload schema';
