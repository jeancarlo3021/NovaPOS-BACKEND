-- Conteo de dólares en efectivo en la apertura y el cierre de caja.
-- Si el negocio no maneja dólares, quedan en 0.
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS opening_usd NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS closing_usd NUMERIC;
