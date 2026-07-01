-- Catálogo CABYS GLOBAL (compartido por todos los negocios). Lo carga el
-- super-admin desde el Excel oficial de Hacienda. No lleva tenant_id.

CREATE TABLE IF NOT EXISTS cabys_catalog (
  code        TEXT PRIMARY KEY,          -- código CABYS (13 díg)
  description TEXT NOT NULL,
  iva_rate    NUMERIC(5,2) NOT NULL DEFAULT 13,
  sheet       TEXT,                       -- 'catalogo' | 'utiles_escolares'
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Búsqueda por descripción (ILIKE) y por código.
CREATE INDEX IF NOT EXISTS idx_cabys_desc ON cabys_catalog USING gin (to_tsvector('spanish', description));
CREATE INDEX IF NOT EXISTS idx_cabys_desc_trgm ON cabys_catalog (description text_pattern_ops);
