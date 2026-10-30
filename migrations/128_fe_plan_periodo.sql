-- ═══════════════════════════════════════════════════════════════════════════
-- CÓMO FUNCIONA LA CUOTA DE UN PLAN FE.
--
-- Hasta ahora `docs_per_month` era una BOLSA: se otorgaban N comprobantes y se
-- gastaban hasta agotarse, sin importar cuánto tardaran. Eso no alcanza para
-- dos planes que sí se venden:
--
--   · «100 comprobantes, válidos por 1 mes» — se vence, no dura hasta gastarse.
--   · «25 comprobantes POR MES» — se reinicia cada mes, no se acumulan.
--
-- `periodo` dice cuál de las tres es:
--   'bolsa'  → como siempre: N comprobantes hasta agotarse, no caduca.
--   'mes'    → N por mes; el contador vuelve a cero el día 1 de cada mes.
--   'unico'  → N por una sola vez, y vence a los `vigencia_meses` meses.
--
-- El valor por defecto es 'bolsa' a propósito: los planes que ya existen y los
-- negocios que los tienen asignados se siguen comportando igual.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE fe_plan_catalog
  ADD COLUMN IF NOT EXISTS periodo        TEXT NOT NULL DEFAULT 'bolsa',
  ADD COLUMN IF NOT EXISTS vigencia_meses INTEGER;

ALTER TABLE fe_plan_catalog DROP CONSTRAINT IF EXISTS fe_plan_catalog_periodo_check;
ALTER TABLE fe_plan_catalog ADD CONSTRAINT fe_plan_catalog_periodo_check
  CHECK (periodo IN ('bolsa', 'mes', 'unico'));

COMMENT ON COLUMN fe_plan_catalog.periodo IS
  'bolsa = hasta agotarse · mes = se reinicia cada mes · unico = vence a los vigencia_meses meses';
COMMENT ON COLUMN fe_plan_catalog.vigencia_meses IS
  'Solo para periodo = unico: cuántos meses vale la cuota (1 = un mes).';

-- Los dos planes pedidos. El PRECIO queda en 0 a propósito: lo pone el negocio
-- en Panel Admin → Planes FE, porque un precio inventado acá se le cobraría a
-- un cliente de verdad.
INSERT INTO fe_plan_catalog
  (id, name, description, price, docs_per_month, extra_doc_price, periodo, vigencia_meses, features)
VALUES
  ('fe-100-un-mes', 'FE 100 por un mes',
   '100 comprobantes electrónicos, válidos por un mes', 0, 100, 0, 'unico', 1,
   '["Tiquete electrónico","Factura electrónica","Nota de crédito"]'),
  ('fe-25-mensual', 'FE 25 al mes',
   '25 comprobantes electrónicos cada mes', 0, 25, 0, 'mes', NULL,
   '["Tiquete electrónico","Factura electrónica"]')
ON CONFLICT (id) DO NOTHING;
