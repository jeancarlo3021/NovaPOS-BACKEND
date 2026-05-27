-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 05: Stock mixto por producto + Feature de plan
-- ═══════════════════════════════════════════════════════════════════════════
-- Permite que algunos productos lleven control de stock y otros no.
-- Controlado por feature de plan: 'inventory_mixed_stock'

-- ── 1. AGREGAR COLUMNA tracks_stock A PRODUCTS ──────────────────────────────
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS tracks_stock BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.products.tracks_stock IS
  'Si TRUE, este producto descuenta stock en cada venta. Si FALSE, se ignora el stock (ej: servicios, productos sin inventario).';

-- ── 2. ÍNDICE PARA QUERIES RÁPIDOS ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_products_tracks_stock
  ON public.products(tenant_id, tracks_stock);

-- ── 3. AGREGAR FEATURE 'inventory_mixed_stock' A LOS PLANES ─────────────────
-- Estructura: la tabla plans tiene una columna 'features' (JSONB)
-- Activamos esta feature solo en planes avanzados

UPDATE public.plans
SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object('inventory_mixed_stock', true)
WHERE LOWER(name) LIKE '%pro%'
   OR LOWER(name) LIKE '%avanzado%'
   OR LOWER(name) LIKE '%premium%'
   OR LOWER(name) LIKE '%enterprise%'
   OR LOWER(name) LIKE '%admin%';

-- Para planes básicos: explícitamente FALSE (no permite mezclar)
UPDATE public.plans
SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object('inventory_mixed_stock', false)
WHERE features IS NULL
   OR NOT (features ? 'inventory_mixed_stock');

-- ── 4. REFRESH SCHEMA CACHE ─────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ── 5. VERIFICACIÓN ─────────────────────────────────────────────────────────

-- Ver productos con su tracks_stock
SELECT
  COUNT(*) FILTER (WHERE tracks_stock) AS con_stock,
  COUNT(*) FILTER (WHERE NOT tracks_stock) AS sin_stock,
  COUNT(*) AS total
FROM public.products;

-- Ver planes y su feature inventory_mixed_stock
SELECT
  name,
  features ->> 'inventory_mixed_stock' AS inventory_mixed_stock
FROM public.plans
ORDER BY name;
