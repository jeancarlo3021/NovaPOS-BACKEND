-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 09: Permisos por Rol
-- ═══════════════════════════════════════════════════════════════════════════
-- Define qué puede hacer cada rol (acceso + CRUD) por módulo, a nivel de tenant.
-- Reemplaza la edición de permisos por usuario individual en la UI.

CREATE TABLE IF NOT EXISTS public.role_permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  role        TEXT NOT NULL,
  module      TEXT NOT NULL,
  can_access  BOOLEAN NOT NULL DEFAULT FALSE,
  can_create  BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit    BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, role, module)
);

CREATE INDEX IF NOT EXISTS idx_role_perm_tenant_role ON public.role_permissions(tenant_id, role);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT tenant_id FROM public.users WHERE id = auth.uid() LIMIT 1;
$$;

DROP POLICY IF EXISTS role_perm_tenant_all ON public.role_permissions;
CREATE POLICY role_perm_tenant_all ON public.role_permissions
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- ── Trigger updated_at ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_role_perm_updated ON public.role_permissions;
CREATE TRIGGER trg_role_perm_updated
  BEFORE UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── Refresh ────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
