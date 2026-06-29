-- Amplía la restricción CHECK de invoices.payment_method para incluir 'credit'
-- (ventas a crédito en POS y en distribución). El esquema original solo permitía
-- cash/card/sinpe, por eso la base rechazaba 'credit' con invoices_payment_method_check.

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payment_method_check;

ALTER TABLE invoices ADD CONSTRAINT invoices_payment_method_check CHECK (
  payment_method IN ('cash', 'card', 'sinpe', 'check', 'transfer', 'credit', 'mixed', 'other')
);
