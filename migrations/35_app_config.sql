-- Configuración GLOBAL de la app (no por tenant). Ej.: cédula del proveedor de
-- sistemas para Facturación Electrónica (la misma para todos los tenants).
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
