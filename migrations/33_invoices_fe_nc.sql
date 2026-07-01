-- Nota de Crédito de anulación: clave y estado de la NC ligada a la factura.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_nc_clave  TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_nc_status TEXT;
