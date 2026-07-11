-- Relación producto → proveedor (opcional). Permite asociar cada producto a un
-- proveedor de la tabla suppliers. ON DELETE SET NULL para no borrar el producto
-- si se elimina el proveedor.
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_products_supplier_id ON products(supplier_id);
