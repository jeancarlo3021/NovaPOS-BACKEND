-- Registra lo que se CARGA a cada camión (acumulado por producto), para poder
-- reconstruir el sobrante = cargado − vendido al reimprimir un cierre, aunque
-- no se haya guardado close_summary.

ALTER TABLE routes ADD COLUMN IF NOT EXISTS loaded_summary JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS close_summary  JSONB;
