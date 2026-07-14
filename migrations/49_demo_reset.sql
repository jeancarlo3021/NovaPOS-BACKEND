-- Demo eterno con auto-reseteo: marca cuándo se limpió por última vez el demo.
-- Cada 8 días se borran productos y movimientos del tenant demo.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS demo_reset_at TIMESTAMPTZ DEFAULT now();
