-- Anulación (borrado lógico) de abonos de cuentas por cobrar.
-- El abono queda MARCADO como anulado (con quién y cuándo), no se borra, para
-- mantener trazabilidad. Los abonos anulados NO cuentan en el saldo.
ALTER TABLE accounts_receivable_payments ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE accounts_receivable_payments ADD COLUMN IF NOT EXISTS voided_by UUID;
