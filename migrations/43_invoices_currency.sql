-- Multimoneda: cada factura guarda en QUÉ moneda se cobró y el tipo de cambio
-- vigente (₡ por $1) al momento de la venta. Los montos (total, subtotal, etc.)
-- quedan en la moneda de la venta. Default 'CRC' para no afectar lo existente.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CRC';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC;         -- ₡ por $1 usado
-- Vuelto: moneda y monto entregados de cambio (para efectivo en $).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS change_currency TEXT;
CREATE INDEX IF NOT EXISTS idx_invoices_currency ON invoices(currency);
