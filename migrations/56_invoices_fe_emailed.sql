-- Marca si ya se envió automáticamente el comprobante electrónico al cliente
-- (para no reenviarlo en cada consulta de estado).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_emailed BOOLEAN DEFAULT false;
