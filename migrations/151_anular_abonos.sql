-- Anular un abono: POR QUÉ se anuló.
--
-- La migración 63 ya guardaba quién y cuándo, pero no el motivo, y un abono
-- anulado sin motivo no se puede auditar: al mes siguiente nadie sabe si fue
-- un error de digitación, un cheque devuelto o un cobro que nunca entró —y el
-- saldo del cliente cambió igual—.
ALTER TABLE accounts_receivable_payments ADD COLUMN IF NOT EXISTS void_reason TEXT;

COMMENT ON COLUMN accounts_receivable_payments.void_reason IS
  'Motivo de la anulación. Obligatorio al anular: un abono anulado sin motivo no se puede auditar.';

-- Para encontrar rápido los abonos de una caja al anular (hay que avisar si esa
-- caja YA está cerrada: el arqueo de ese turno queda con plata de más).
CREATE INDEX IF NOT EXISTS idx_arp_sesion_vigentes
  ON accounts_receivable_payments (cash_session_id)
  WHERE voided_at IS NULL;
