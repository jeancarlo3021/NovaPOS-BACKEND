-- PLANILLA — EL DESGLOSE QUE FALTABA
--
-- La planilla calculaba con dos porcentajes globales: 10,67% de cuota obrera
-- y 26,67% de cuota patronal. Los tres huecos que eso dejaba:
--
--   · No se podía EXPLICAR. El comprobante de pago decía «se le rebajó
--     ₡53.350» sin decir de qué. El trabajador tiene derecho a ver SEM, IVM
--     y Banco Popular por separado.
--   · El INS estaba metido dentro del 26,67%. El seguro de riesgos del
--     trabajo es una PÓLIZA APARTE con tarifa según la actividad del
--     negocio; mezclado ahí no se podía ajustar, y una soda pagaba lo mismo
--     que un taller.
--   · No había IMPUESTO SOBRE LA RENTA ni forma de anotar un préstamo, la
--     asociación solidarista, una pensión alimentaria o un embargo. Las
--     columnas `advances` y `other_deductions` existían y SIEMPRE valían
--     cero, así que el neto que mostraba el sistema no era el que la persona
--     recibía.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. LAS TASAS, CONFIGURABLES
-- ══════════════════════════════════════════════════════════════════════════

/**
 * Las tasas del negocio.
 *
 * ── Por qué una tabla y no constantes en el código ───────────────────────
 * Cambian por ley cada año: el IVM subió el 1.º de enero de 2026 y los
 * tramos del impuesto se ajustan por decreto cada diciembre. Con las tasas
 * en el código, cada enero habría que desplegar una versión nueva para que
 * la planilla saliera bien, y mientras tanto sale mal.
 *
 * ── Por qué JSONB y no una columna por rubro ─────────────────────────────
 * Los rubros cambian: el ROP no existía en 2000 y el escalonamiento del IVM
 * agrega escalones hasta 2029. Una columna por rubro obliga a una migración
 * cada vez que la ley agrega una línea.
 */
CREATE TABLE IF NOT EXISTS public.payroll_settings (
  tenant_id  UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  config     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.payroll_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_settings_tenant_all ON public.payroll_settings;
CREATE POLICY payroll_settings_tenant_all ON public.payroll_settings
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- ══════════════════════════════════════════════════════════════════════════
-- 2. LAS DEDUCCIONES DE CADA EMPLEADO
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.employee_deductions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  employee_id    UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  -- prestamo | solidarista | cooperativa | pension_alimentaria | embargo
  -- | ahorro | asociacion | otro
  tipo           TEXT NOT NULL DEFAULT 'otro',
  /** Cómo se llama en el comprobante de pago. */
  label          TEXT NOT NULL,
  -- 'fijo' (colones por mes) o 'porcentaje' (del bruto)
  modo           TEXT NOT NULL DEFAULT 'fijo' CHECK (modo IN ('fijo','porcentaje')),
  monto          NUMERIC(12,2) NOT NULL DEFAULT 0,
  pct            NUMERIC(6,3)  NOT NULL DEFAULT 0,
  /** Tope mensual, para las de porcentaje. */
  tope           NUMERIC(12,2),
  /**
   * Para los PRÉSTAMOS: cuánto se debe en total y cuánto falta.
   *
   * `saldo_restante` es lo que hace que un préstamo se detenga solo. Sin
   * esto, uno de ₡200.000 en cuotas de ₡25.000 seguiría rebajando el mes
   * nueve y el diez, y nadie lo nota hasta que el empleado reclama.
   */
  saldo_total    NUMERIC(12,2),
  saldo_restante NUMERIC(12,2),
  desde          DATE,
  hasta          DATE,
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  notas          TEXT,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Ni montos ni porcentajes negativos: una deducción negativa es un pago,
  -- y un pago se registra como bonificación, no como descuento al revés.
  CONSTRAINT employee_deductions_signos CHECK (monto >= 0 AND pct >= 0)
);

CREATE INDEX IF NOT EXISTS employee_deductions_emp_idx
  ON public.employee_deductions (tenant_id, employee_id) WHERE activo;

ALTER TABLE public.employee_deductions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employee_deductions_tenant_all ON public.employee_deductions;
CREATE POLICY employee_deductions_tenant_all ON public.employee_deductions
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- ══════════════════════════════════════════════════════════════════════════
-- 3. LO QUE EL EXPEDIENTE NECESITA PARA EL IMPUESTO
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.employees
  /** Créditos familiares del impuesto sobre la renta. */
  ADD COLUMN IF NOT EXISTS dependents_children INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS has_spouse          BOOLEAN NOT NULL DEFAULT FALSE,
  /**
   * Quien no está sujeto a retención.
   *
   * Existe para los casos reales en que la retención no corre (un régimen
   * especial, una resolución). Sin la bandera, la única forma de no retener
   * era poner el salario mal, que es peor.
   */
  ADD COLUMN IF NOT EXISTS tax_exempt          BOOLEAN NOT NULL DEFAULT FALSE;

-- ══════════════════════════════════════════════════════════════════════════
-- 4. EL DESGLOSE, CONGELADO EN CADA PLANILLA
-- ══════════════════════════════════════════════════════════════════════════

/**
 * El desglose se GUARDA con la planilla, no se recalcula al abrirla.
 *
 * Es la misma razón por la que ya se congelaban los montos: cuando el IVM
 * sube en enero, la planilla de diciembre tiene que seguir diciendo lo que
 * se le rebajó en diciembre. Un desglose recalculado mostraría las tasas de
 * hoy sobre los salarios de entonces, y no cuadraría con el comprobante que
 * la persona tiene en la mano.
 */
ALTER TABLE public.payroll_items
  ADD COLUMN IF NOT EXISTS employee_charges_detail JSONB,
  ADD COLUMN IF NOT EXISTS income_tax              NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS income_tax_detail       JSONB,
  ADD COLUMN IF NOT EXISTS deductions_detail       JSONB,
  ADD COLUMN IF NOT EXISTS employer_charges        NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_charges_detail JSONB,
  ADD COLUMN IF NOT EXISTS ins_amount              NUMERIC(12,2) NOT NULL DEFAULT 0,
  /** Sobre cuánto se calcularon las cuotas (puede ser la base mínima). */
  ADD COLUMN IF NOT EXISTS contribution_base       NUMERIC(12,2);

ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS employee_charges_detail JSONB,
  ADD COLUMN IF NOT EXISTS employer_charges_detail JSONB,
  ADD COLUMN IF NOT EXISTS other_deductions_detail JSONB,
  ADD COLUMN IF NOT EXISTS income_tax              NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ins_amount              NUMERIC(14,2) NOT NULL DEFAULT 0,
  /** Las tasas con las que se calculó, tal cual estaban ese día. */
  ADD COLUMN IF NOT EXISTS rates_snapshot          JSONB;

NOTIFY pgrst, 'reload schema';
