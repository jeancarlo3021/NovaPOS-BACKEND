-- Combos/bundles de promociones: modo de precio del combo.
--   'price'   → el combo vale un precio fijo (value)
--   'percent' → % de descuento sobre la suma de los productos del combo (value)
-- Los productos del combo van en product_ids; el tipo es 'bundle' o 'combo'.
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS combo_mode TEXT;
