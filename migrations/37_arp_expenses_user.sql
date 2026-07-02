-- Atribuir abonos de CxC y gastos al usuario que los registró (para reflejarlos
-- en la liquidación del cierre del repartidor).
ALTER TABLE accounts_receivable_payments ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE expenses                      ADD COLUMN IF NOT EXISTS user_id UUID;
