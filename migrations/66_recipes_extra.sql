-- Campos extra de recetas: costeo/precio, cocina, menú/salud y gestión.
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS target_margin_pct NUMERIC;   -- margen objetivo → precio sugerido
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS station         TEXT;        -- estación de cocina (Cocina, Barra…)
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS allergens       TEXT;        -- alérgenos (lista libre)
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS diet_tags       TEXT;        -- vegano, sin gluten, etc.
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS calories        NUMERIC;     -- kcal por porción
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS protein_g       NUMERIC;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS carbs_g         NUMERIC;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS fat_g           NUMERIC;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS photo_url       TEXT;        -- foto del plato
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS available_from  DATE;        -- disponibilidad estacional
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS available_to    DATE;
