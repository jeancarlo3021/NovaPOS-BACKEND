-- Nota de Débito (TipoComprobante 02): clave y estado de la ND ligada a la factura.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_nd_clave  TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_nd_status TEXT;
