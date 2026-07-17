-- Ambiente de Hacienda en que se emitió el comprobante electrónico:
-- 'production' (validez fiscal) o 'sandbox' (QA / pruebas). Sirve para separar
-- las facturas de prueba de las reales en el reporte de impuestos.
-- Las filas existentes quedan NULL → se tratan como producción (reales).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_environment TEXT;

CREATE INDEX IF NOT EXISTS idx_invoices_fe_environment ON invoices (tenant_id, fe_environment);
