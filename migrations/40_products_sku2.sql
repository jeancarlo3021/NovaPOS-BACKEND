-- Segundo código por producto (código alterno / de barras), además del SKU.
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku2 TEXT;
