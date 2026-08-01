-- Búsqueda de CABYS SIN tildes: hoy el ilike se hace contra la descripción con
-- tildes, así que "melon" no encuentra "melón". Guardamos una versión normalizada
-- (minúsculas + sin acentos) y buscamos contra ella.

ALTER TABLE cabys_catalog ADD COLUMN IF NOT EXISTS description_norm TEXT;

-- Backfill de las filas existentes (translate cubre las vocales acentuadas + ñ,
-- no requiere la extensión unaccent).
UPDATE cabys_catalog
SET description_norm = lower(translate(
  description,
  'ÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑáàäâãéèëêíìïîóòöôõúùüûñ',
  'AAAAAEEEEIIIIOOOOOUUUUNaaaaaeeeeiiiiooooouuuun'))
WHERE description_norm IS NULL OR description_norm = '';

-- Índice trigram para que el LIKE '%texto%' sea rápido sobre el catálogo grande.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_cabys_desc_norm_trgm
  ON cabys_catalog USING gin (description_norm gin_trgm_ops);
