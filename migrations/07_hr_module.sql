-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 07: Módulo de Recursos Humanos
-- ═══════════════════════════════════════════════════════════════════════════
-- Tablas: employees, attendance_records, leave_requests

-- ── 1. EMPLOYEES ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.employees (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL,
  user_id                  UUID REFERENCES auth.users(id) ON DELETE SET NULL,  -- Opcional: vincular a usuario del sistema
  full_name                TEXT NOT NULL,
  identification           TEXT,
  email                    TEXT,
  phone                    TEXT,
  position                 TEXT NOT NULL,
  department               TEXT NOT NULL DEFAULT 'Salón',
  hourly_rate              NUMERIC(10, 2),
  monthly_salary           NUMERIC(12, 2),
  commission_pct           NUMERIC(5, 2),
  hire_date                DATE NOT NULL DEFAULT CURRENT_DATE,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','inactive','vacation','leave')),
  health_cert_expires_at   DATE,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_tenant   ON public.employees(tenant_id);
CREATE INDEX IF NOT EXISTS idx_employees_status   ON public.employees(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_employees_user     ON public.employees(user_id);

-- ── 2. ATTENDANCE_RECORDS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  employee_id     UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  clock_in        TIMESTAMPTZ,
  clock_out       TIMESTAMPTZ,
  break_minutes   INTEGER DEFAULT 0,
  hours_worked    NUMERIC(5, 2),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(employee_id, date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_tenant_date ON public.attendance_records(tenant_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_employee    ON public.attendance_records(employee_id, date DESC);

-- ── 3. LEAVE_REQUESTS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leave_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  employee_id     UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  employee_name   TEXT,                -- snapshot
  type            TEXT NOT NULL CHECK (type IN ('vacation','sick','personal','maternity','other')),
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  days            INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leave_tenant_date  ON public.leave_requests(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leave_employee     ON public.leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_status       ON public.leave_requests(tenant_id, status);

-- ── 4. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;

-- Helper: función que retorna el tenant del usuario actual
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT tenant_id FROM public.users WHERE id = auth.uid() LIMIT 1;
$$;

-- Employees: todo lo del tenant
DROP POLICY IF EXISTS employees_tenant_all ON public.employees;
CREATE POLICY employees_tenant_all ON public.employees
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- Attendance: todo lo del tenant
DROP POLICY IF EXISTS attendance_tenant_all ON public.attendance_records;
CREATE POLICY attendance_tenant_all ON public.attendance_records
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- Leave requests: todo lo del tenant
DROP POLICY IF EXISTS leave_tenant_all ON public.leave_requests;
CREATE POLICY leave_tenant_all ON public.leave_requests
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- ── 5. TRIGGER updated_at ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employees_updated ON public.employees;
CREATE TRIGGER trg_employees_updated
  BEFORE UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 6. REFRESH ─────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ── 7. VERIFICACIÓN ────────────────────────────────────────────────────────
SELECT 'employees' AS tabla, COUNT(*) FROM public.employees
UNION ALL
SELECT 'attendance_records', COUNT(*) FROM public.attendance_records
UNION ALL
SELECT 'leave_requests', COUNT(*) FROM public.leave_requests;
