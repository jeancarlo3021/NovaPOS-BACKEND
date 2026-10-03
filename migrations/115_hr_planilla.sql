-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 115: Recursos Humanos — columnas que faltaban y PLANILLA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── Qué pasaba ─────────────────────────────────────────────────────────────
-- El módulo de RRHH guardaba el expediente del empleado, la asistencia y las
-- ausencias, pero la «Nómina» NO EXISTÍA como dato: era una calculadora que
-- multiplicaba el salario del expediente y mostraba el resultado en pantalla.
-- Al salir de la página no quedaba nada. Eso tiene tres consecuencias:
--
--   · No se puede saber cuánto se pagó el mes pasado, ni reimprimir la planilla,
--     ni comparar. Si alguien le sube el salario a un empleado, los meses
--     anteriores «cambian» hacia atrás, porque se recalculan con el salario de
--     hoy.
--   · La planilla no aparecía en Gastos ni en los reportes de utilidad: el
--     negocio veía una ganancia que no existía, porque el gasto más grande del
--     mes no estaba contado.
--   · La comisión se calculaba como un porcentaje del SALARIO. Una comisión es
--     un porcentaje de las VENTAS; así como estaba, un vendedor que no vendía
--     nada igual «generaba» comisión, y uno que vendía el doble cobraba igual.
--
-- Esta migración agrega las columnas del expediente que el módulo necesita para
-- trabajar de verdad (sucursal, tipo de salario, forma de pago, contrato,
-- vacaciones, contacto de emergencia) y crea las dos tablas de la planilla, con
-- los montos CONGELADOS: una planilla pagada es un hecho histórico, no un
-- cálculo que se vuelve a hacer.

-- ── 1. EMPLEADOS: lo que faltaba en el expediente ───────────────────────────
ALTER TABLE public.employees
  -- En qué sucursal trabaja. Sin esto, un grupo con tres locales tenía toda la
  -- planilla junta y no se podía saber cuánto cuesta cada local.
  ADD COLUMN IF NOT EXISTS branch_id              UUID,
  -- Cómo se le paga: salario fijo al mes, por hora, o solo comisión.
  ADD COLUMN IF NOT EXISTS salary_type            TEXT NOT NULL DEFAULT 'monthly',
  -- Sobre qué se calcula la comisión: las VENTAS que hizo (lo normal) o su
  -- salario (que es lo que hacía el cálculo viejo, y casi nunca es lo correcto).
  ADD COLUMN IF NOT EXISTS commission_base        TEXT NOT NULL DEFAULT 'sales',
  -- Cómo se le paga la planilla y a dónde.
  ADD COLUMN IF NOT EXISTS payment_method         TEXT,
  ADD COLUMN IF NOT EXISTS bank_account           TEXT,
  ADD COLUMN IF NOT EXISTS birth_date             DATE,
  ADD COLUMN IF NOT EXISTS emergency_contact      TEXT,
  ADD COLUMN IF NOT EXISTS emergency_phone        TEXT,
  -- Tipo de contrato y, si es a plazo, cuándo se vence: es un aviso que hay que
  -- dar ANTES, no enterarse el día que ya venció.
  ADD COLUMN IF NOT EXISTS contract_type          TEXT,
  ADD COLUMN IF NOT EXISTS contract_end_date      DATE,
  -- Vacaciones: en Costa Rica son dos semanas por año de trabajo (12 días
  -- hábiles). Se guarda por empleado porque hay negocios que dan más.
  ADD COLUMN IF NOT EXISTS vacation_days_per_year NUMERIC(5,2) NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS photo_url              TEXT,
  -- Salida: la fecha y el motivo. Antes el empleado solo pasaba a 'inactive' y
  -- se perdía cuándo y por qué, que es justo lo que se necesita para liquidar.
  ADD COLUMN IF NOT EXISTS terminated_at          DATE,
  ADD COLUMN IF NOT EXISTS termination_reason     TEXT;

-- Los CHECK van aparte y tolerantes: una fila vieja con el campo en null no
-- debe impedir que la migración corra.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_salary_type_check') THEN
    ALTER TABLE public.employees ADD CONSTRAINT employees_salary_type_check
      CHECK (salary_type IN ('monthly','hourly','commission'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_commission_base_check') THEN
    ALTER TABLE public.employees ADD CONSTRAINT employees_commission_base_check
      CHECK (commission_base IN ('sales','salary'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_employees_branch ON public.employees(tenant_id, branch_id);

-- ── 2. ASISTENCIA: sucursal, tardía y de dónde salió el marcaje ─────────────
ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS branch_id     UUID,
  -- Minutos de tardía respecto a la hora de entrada acordada. Se guarda calculado
  -- porque el horario puede cambiar después y la tardía de ese día no.
  ADD COLUMN IF NOT EXISTS late_minutes  INTEGER NOT NULL DEFAULT 0,
  -- Quién marcó: a mano desde RRHH, desde el punto de venta, o el empleado en su
  -- teléfono. Importa cuando hay un reclamo por horas.
  ADD COLUMN IF NOT EXISTS source        TEXT NOT NULL DEFAULT 'manual';

-- ── 3. AUSENCIAS: si se pagan y el respaldo ─────────────────────────────────
ALTER TABLE public.leave_requests
  -- Vacaciones e incapacidad se pagan; un permiso sin goce de salario, no. Es la
  -- diferencia entre descontar o no en la planilla del período.
  ADD COLUMN IF NOT EXISTS paid           BOOLEAN NOT NULL DEFAULT TRUE,
  -- La boleta de la Caja, el dictamen médico, la carta: el papel que respalda.
  ADD COLUMN IF NOT EXISTS attachment_url TEXT;

-- ── 4. PLANILLAS (una por período) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  branch_id         UUID,
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  -- 'draft'    — se está armando, se puede recalcular y borrar.
  -- 'approved' — los números quedaron fijos.
  -- 'paid'     — se pagó; queda el gasto asociado y ya no se toca.
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','approved','paid')),
  -- Totales del período, congelados al aprobar.
  gross             NUMERIC(14,2) NOT NULL DEFAULT 0,
  employee_charges  NUMERIC(14,2) NOT NULL DEFAULT 0,   -- lo que se le descuenta (CCSS obrero)
  other_deductions  NUMERIC(14,2) NOT NULL DEFAULT 0,   -- adelantos y otros
  employer_charges  NUMERIC(14,2) NOT NULL DEFAULT 0,   -- cargas patronales
  net               NUMERIC(14,2) NOT NULL DEFAULT 0,   -- lo que se le entrega
  total_cost        NUMERIC(14,2) NOT NULL DEFAULT 0,   -- lo que le cuesta al negocio
  employees_count   INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  /**
   * El GASTO que esta planilla generó.
   *
   * Es el vínculo con el resto del sistema: la planilla pagada entra a Gastos y
   * de ahí a los reportes de utilidad. Sin esto, el gasto más grande del mes no
   * aparecía en ninguna parte y la ganancia que mostraba el sistema era mentira.
   */
  expense_id        UUID,
  created_by        UUID,
  approved_at       TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Una sola planilla por período y sucursal: evita pagar dos veces el mismo mes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_run_periodo
  ON public.payroll_runs (tenant_id, period_start, period_end, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_payroll_runs_tenant ON public.payroll_runs(tenant_id, period_start DESC);

-- ── 5. LÍNEAS DE LA PLANILLA (una por empleado) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  run_id            UUID NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  employee_id       UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  -- Nombre y cargo como FOTO del momento: el expediente puede cambiar o el
  -- empleado irse, y la planilla de marzo tiene que seguir legible en marzo.
  employee_name     TEXT NOT NULL,
  position          TEXT,
  salary_type       TEXT,
  -- Salario del período (fijo, o horas × tarifa).
  base_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  hours             NUMERIC(8,2),
  hourly_rate       NUMERIC(10,2),
  -- Comisión: el % y SOBRE CUÁNTO se calculó. Guardar las ventas del período es
  -- lo que permite que el empleado revise su comisión y cuadre.
  commission_pct    NUMERIC(5,2),
  commission_sales  NUMERIC(14,2) NOT NULL DEFAULT 0,
  commission_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  bonuses           NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Adelantos que ya se le dieron en el período y otros descuentos.
  advances          NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_deductions  NUMERIC(12,2) NOT NULL DEFAULT 0,
  employee_charges  NUMERIC(12,2) NOT NULL DEFAULT 0,
  gross             NUMERIC(12,2) NOT NULL DEFAULT 0,
  net               NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method    TEXT,
  -- Días de ausencia no pagada del período (sale de leave_requests).
  unpaid_days       NUMERIC(5,2) NOT NULL DEFAULT 0,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_items_run      ON public.payroll_items(run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_items_employee ON public.payroll_items(employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_items_tenant   ON public.payroll_items(tenant_id);

-- ── 6. RLS — igual que el resto del módulo ──────────────────────────────────
ALTER TABLE public.payroll_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_runs_tenant_all ON public.payroll_runs;
CREATE POLICY payroll_runs_tenant_all ON public.payroll_runs
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS payroll_items_tenant_all ON public.payroll_items;
CREATE POLICY payroll_items_tenant_all ON public.payroll_items
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

DROP TRIGGER IF EXISTS trg_payroll_runs_updated ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs_updated
  BEFORE UPDATE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 7. REFRESH ─────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ── 8. VERIFICACIÓN ────────────────────────────────────────────────────────
SELECT 'payroll_runs'  AS tabla, COUNT(*) FROM public.payroll_runs
UNION ALL
SELECT 'payroll_items', COUNT(*) FROM public.payroll_items;

SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'employees'
   AND column_name IN ('branch_id','salary_type','commission_base','payment_method',
                       'contract_type','vacation_days_per_year','terminated_at')
 ORDER BY column_name;
