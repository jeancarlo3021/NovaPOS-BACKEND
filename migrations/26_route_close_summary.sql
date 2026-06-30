-- Guarda el resumen del cierre de ruta para poder REIMPRIMIRLO después
-- (ventas por método, totales, sobrante devuelto).

ALTER TABLE routes ADD COLUMN IF NOT EXISTS close_summary JSONB;
