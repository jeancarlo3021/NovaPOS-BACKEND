-- Catálogo de planes de Facturación Electrónica (editable en Panel Admin).
-- Se usa un nombre nuevo (fe_plan_catalog) porque puede existir una tabla
-- fe_plans previa con id uuid, incompatible con ids de texto ('fe-inicial').
CREATE TABLE IF NOT EXISTS fe_plan_catalog (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  description     TEXT DEFAULT '',
  price           NUMERIC(12,2) NOT NULL DEFAULT 0,
  docs_per_month  INTEGER,                 -- null = ilimitado
  extra_doc_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  features        JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO fe_plan_catalog (id, name, description, price, docs_per_month, extra_doc_price, features) VALUES
  ('fe-inicial',   'FE Inicial',   'Para negocios que arrancan con FE', 5000,  50,   80, '["Tiquete electrónico","Factura electrónica"]'),
  ('fe-pyme',      'FE Pyme',      'Volumen medio de comprobantes',     12000, 300,  60, '["Tiquete","Factura","Nota de crédito"]'),
  ('fe-pro',       'FE Pro',       'Alto volumen mensual',              25000, 1000, 40, '["Todos los documentos","Reportes Hacienda"]'),
  ('fe-ilimitado', 'FE Ilimitado', 'Comprobantes sin límite',           45000, NULL, 0,  '["Comprobantes ilimitados","Soporte prioritario"]')
ON CONFLICT (id) DO NOTHING;
