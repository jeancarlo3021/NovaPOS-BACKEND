-- Recetas y subrecetas (fichas técnicas de cocina).
-- Una RECETA produce un producto vendible; una SUBRECETA es una preparación base
-- (ej. salsa, masa) que se usa como ingrediente dentro de otras recetas.
CREATE TABLE IF NOT EXISTS recipes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  name          TEXT NOT NULL,
  is_subrecipe  BOOLEAN NOT NULL DEFAULT false,   -- true = preparación base
  product_id    UUID,                             -- producto vendible que produce (opcional)
  yield_qty     NUMERIC NOT NULL DEFAULT 1,       -- cuánto rinde (porciones/litros/kg)
  yield_unit    TEXT DEFAULT 'porción',
  prep_minutes  INT,                              -- tiempo de preparación
  instructions  TEXT,                             -- pasos de preparación
  notes         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recipes_tenant ON recipes (tenant_id);

-- Ingredientes de una receta: un producto de inventario O una subreceta.
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  recipe_id     UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  type          TEXT NOT NULL DEFAULT 'product',  -- 'product' | 'subrecipe'
  product_id    UUID,                             -- si type='product'
  sub_recipe_id UUID,                             -- si type='subrecipe'
  quantity      NUMERIC NOT NULL DEFAULT 0,
  unit          TEXT,
  waste_pct     NUMERIC NOT NULL DEFAULT 0,       -- merma % (se cocina/pela y se pierde)
  note          TEXT,
  seq           INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON recipe_ingredients (recipe_id);
