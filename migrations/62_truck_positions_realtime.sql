-- Habilita Supabase Realtime sobre truck_positions para el mapa en vivo.
-- REPLICA IDENTITY FULL: el payload incluye todas las columnas (para filtrar por
-- tenant_id en updates). Luego se agrega a la publicación supabase_realtime.
ALTER TABLE truck_positions REPLICA IDENTITY FULL;

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE truck_positions;
  EXCEPTION
    WHEN duplicate_object THEN NULL;   -- ya estaba agregada
    WHEN undefined_object THEN NULL;   -- la publicación no existe (entorno no-Supabase)
  END;
END $$;
