-- POR QUÉ se anuló una venta.
--
-- El motivo se pedía en pantalla desde siempre… y se tiraba: solo se usaba
-- como razón de la Nota de Crédito, así que de una venta corriente (sin
-- comprobante electrónico) no quedaba nada. El cajero escribía «el cliente se
-- arrepintió» y eso no llegaba a ninguna parte.
--
-- Importa porque las anulaciones son el agujero clásico de un POS: anular una
-- venta y quedarse con la plata no deja rastro si nadie anotó por qué se
-- anuló. Con el motivo, quién y cuándo, un patrón raro se ve.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS void_reason TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS voided_by UUID;

COMMENT ON COLUMN invoices.void_reason IS
  'Motivo de la anulación, tal como lo escribió quien anuló. Se pide en pantalla al anular.';

-- Para listar las anulaciones de un período sin recorrer todas las facturas.
CREATE INDEX IF NOT EXISTS idx_invoices_anuladas
  ON invoices (tenant_id, voided_at DESC)
  WHERE status = 'cancelled';
