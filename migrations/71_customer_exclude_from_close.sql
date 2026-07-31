-- Clientes que NO se contabilizan en el cierre de caja (ej. compras de empleados a
-- crédito): la venta se registra pero no suma en el arqueo/total del cierre.
--   · customers.exclude_from_cash_close → marca el cliente.
--   · invoices.exclude_from_close       → se copia al vender, para que el cierre
--     filtre sin tener que unir con customers.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS exclude_from_cash_close BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE invoices  ADD COLUMN IF NOT EXISTS exclude_from_close      BOOLEAN NOT NULL DEFAULT false;
