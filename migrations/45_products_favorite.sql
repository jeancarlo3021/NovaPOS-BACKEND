-- Producto favorito: aparece de primero en el POS.
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_products_favorite ON products(tenant_id, is_favorite);
