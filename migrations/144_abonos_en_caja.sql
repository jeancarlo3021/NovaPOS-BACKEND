-- Abonos de cuentas por cobrar que SÍ pasaron por una caja.
--
-- Un abono se cobra muchas veces fuera del POS (en la oficina, por depósito o
-- por SINPE), así que no se puede meter al arqueo por fecha: al cajero le
-- sobraría plata que nunca pasó por su gaveta. Con esta columna el abono queda
-- ligado a la caja que lo recibió —y solo esa caja lo cuenta en su cierre—.
-- NULL = no entró por caja (oficina, depósito, repartidor), como hasta ahora.
ALTER TABLE accounts_receivable_payments
  ADD COLUMN IF NOT EXISTS cash_session_id UUID;

CREATE INDEX IF NOT EXISTS idx_arp_session
  ON accounts_receivable_payments (tenant_id, cash_session_id);

-- Los reportes de abonos cobrados filtran por fecha dentro del tenant.
CREATE INDEX IF NOT EXISTS idx_arp_tenant_fecha
  ON accounts_receivable_payments (tenant_id, created_at);
