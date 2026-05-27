-- Migración: Agregar columna 'min_purchase' a la tabla promotions
-- Resuelve error: "Could not find the 'min_purchase' column of 'promotions' in the schema cache"
--
-- Schema actual:
--   - id, tenant_id, name, description, type, value
--   - applies_to, category_id (→ product_categories), product_ids
--   - starts_at, ends_at, is_active
--   - created_at, updated_at
--
-- Falta: min_purchase

-- ── Agregar columna min_purchase ─────────────────────────────────────────────
ALTER TABLE public.promotions
  ADD COLUMN IF NOT EXISTS min_purchase NUMERIC(12, 2) DEFAULT NULL;

COMMENT ON COLUMN public.promotions.min_purchase IS
  'Monto mínimo de compra para que aplique la promoción. NULL = sin mínimo.';

-- ── Forzar refresh del schema cache de PostgREST/Supabase ────────────────────
-- CRÍTICO: sin esto, Supabase sigue creyendo que la columna no existe
NOTIFY pgrst, 'reload schema';

-- ── Verificación ─────────────────────────────────────────────────────────────
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'promotions'
ORDER BY ordinal_position;
