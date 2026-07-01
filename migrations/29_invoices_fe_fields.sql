-- Campos de Facturación Electrónica en invoices: guardan lo emitido/recibido de
-- Hacienda (vía Facturemos) para consultar estatus y reimprimir.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_clave        TEXT;           -- clave numérica 50 díg
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_consecutivo  TEXT;           -- consecutivo 20 díg
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_status       TEXT;           -- pending|sent|accepted|rejected|error
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_xml          TEXT;           -- respuesta XML de Hacienda (base64)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_error        TEXT;           -- mensaje de error de Hacienda
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_situacion    TEXT;           -- 1 normal | 2 contingencia | 3 sin internet
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sale_condition  TEXT;           -- 01 contado | 02 crédito

CREATE INDEX IF NOT EXISTS idx_invoices_fe_status ON invoices(tenant_id, fe_status);
