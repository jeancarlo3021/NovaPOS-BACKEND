-- Recepción: guardar los artículos (líneas) del comprobante del proveedor y
-- clasificar cada comprobante como 'gasto' o 'compra' (compra a proveedor).
ALTER TABLE received_documents ADD COLUMN IF NOT EXISTS items JSONB;
ALTER TABLE received_documents ADD COLUMN IF NOT EXISTS kind  TEXT;   -- 'gasto' | 'compra'
