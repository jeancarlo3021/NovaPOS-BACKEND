-- Soft-delete de productos: cuando un producto tiene compras/ventas asociadas no
-- se puede borrar (FK), así que se OCULTA marcando deleted_at. Los listados
-- filtran deleted_at IS NULL. El historial (purchase_items/invoice_items) se
-- conserva intacto.
ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_products_deleted_at ON products (tenant_id, deleted_at);
