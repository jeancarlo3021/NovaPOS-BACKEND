-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 08: Módulo Usuarios completo
-- ═══════════════════════════════════════════════════════════════════════════
-- Tablas: user_permissions, user_activity_log, teams, team_members, shifts
-- (La tabla 'users' ya existe del setup inicial)

-- ── 1. USER_PERMISSIONS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  module      TEXT NOT NULL,
  can_access  BOOLEAN NOT NULL DEFAULT FALSE,
  can_create  BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit    BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, module)
);

CREATE INDEX IF NOT EXISTS idx_user_perm_tenant_user ON public.user_permissions(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_perm_user_module ON public.user_permissions(user_id, module);

-- ── 2. USER_ACTIVITY_LOG ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_activity_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  user_id      UUID REFERENCES public.users(id) ON DELETE SET NULL,
  user_name    TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  details      JSONB,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_tenant_date ON public.user_activity_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user        ON public.user_activity_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_action      ON public.user_activity_log(tenant_id, action);

-- ── 3. TEAMS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  color       TEXT NOT NULL DEFAULT '#3b82f6',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_teams_tenant ON public.teams(tenant_id);

-- ── 4. TEAM_MEMBERS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.team_members (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id   UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_team ON public.team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON public.team_members(user_id);

-- ── 5. SHIFTS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shifts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  user_id         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  team_id         UUID REFERENCES public.teams(id) ON DELETE SET NULL,
  start_datetime  TIMESTAMPTZ NOT NULL,
  end_datetime    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','active','completed','cancelled')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Al menos uno: user_id o team_id
  CONSTRAINT shifts_target_check CHECK (user_id IS NOT NULL OR team_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_shifts_tenant_date ON public.shifts(tenant_id, start_datetime);
CREATE INDEX IF NOT EXISTS idx_shifts_user        ON public.shifts(user_id, start_datetime);
CREATE INDEX IF NOT EXISTS idx_shifts_team        ON public.shifts(team_id, start_datetime);

-- ── 6. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.user_permissions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shifts            ENABLE ROW LEVEL SECURITY;

-- Función helper si no existe
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT tenant_id FROM public.users WHERE id = auth.uid() LIMIT 1;
$$;

-- Permissions
DROP POLICY IF EXISTS user_perm_tenant_all ON public.user_permissions;
CREATE POLICY user_perm_tenant_all ON public.user_permissions
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- Activity Log
DROP POLICY IF EXISTS activity_tenant_all ON public.user_activity_log;
CREATE POLICY activity_tenant_all ON public.user_activity_log
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- Teams
DROP POLICY IF EXISTS teams_tenant_all ON public.teams;
CREATE POLICY teams_tenant_all ON public.teams
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- Team members (via team)
DROP POLICY IF EXISTS team_members_tenant_all ON public.team_members;
CREATE POLICY team_members_tenant_all ON public.team_members
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.teams t
      WHERE t.id = team_id AND t.tenant_id = public.current_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.teams t
      WHERE t.id = team_id AND t.tenant_id = public.current_tenant_id()
    )
  );

-- Shifts
DROP POLICY IF EXISTS shifts_tenant_all ON public.shifts;
CREATE POLICY shifts_tenant_all ON public.shifts
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- ── 7. TRIGGERS updated_at ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_perm_updated ON public.user_permissions;
CREATE TRIGGER trg_user_perm_updated
  BEFORE UPDATE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_teams_updated ON public.teams;
CREATE TRIGGER trg_teams_updated
  BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_shifts_updated ON public.shifts;
CREATE TRIGGER trg_shifts_updated
  BEFORE UPDATE ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 8. REFRESH ─────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ── 9. VERIFICACIÓN ────────────────────────────────────────────────────────
SELECT 'user_permissions'  AS tabla, COUNT(*) FROM public.user_permissions
UNION ALL SELECT 'user_activity_log', COUNT(*) FROM public.user_activity_log
UNION ALL SELECT 'teams',             COUNT(*) FROM public.teams
UNION ALL SELECT 'team_members',      COUNT(*) FROM public.team_members
UNION ALL SELECT 'shifts',            COUNT(*) FROM public.shifts;
