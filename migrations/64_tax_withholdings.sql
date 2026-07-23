-- Retenciones para el formulario D-150 (Resumen Anual de Retenciones — Hacienda CR).
-- Cada fila = una retención hecha a un beneficiario (proveedor, empleado, etc.):
-- el monto pagado (base) y el monto retenido, por concepto y año.
CREATE TABLE IF NOT EXISTS tax_withholdings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  period_year         INT  NOT NULL,                 -- año de la declaración
  concept             TEXT NOT NULL,                 -- concepto/código de retención
  beneficiary_id_type TEXT,                          -- 01 física, 02 jurídica, 03 DIMEX…
  beneficiary_id      TEXT,                          -- cédula del beneficiario
  beneficiary_name    TEXT NOT NULL,
  base_amount         NUMERIC NOT NULL DEFAULT 0,    -- monto pagado (renta bruta)
  withheld_amount     NUMERIC NOT NULL DEFAULT 0,    -- monto retenido
  paid_at             DATE,                          -- fecha del pago/retención
  note                TEXT,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tax_withholdings_tenant_year
  ON tax_withholdings (tenant_id, period_year);
