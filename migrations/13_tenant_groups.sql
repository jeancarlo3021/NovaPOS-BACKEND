-- ============================================================================
-- 13_tenant_groups.sql — Multi-empresa con grupos y planes FE independientes
-- ============================================================================
-- Crea la infraestructura para que una "empresa matriz" tenga N sucursales,
-- cada una con su propio plan SaaS Y su propio plan de Facturación Electrónica.
--
-- Tablas nuevas:
--   - tenant_groups          → la matriz (grupo de empresas)
--   - tenant_group_members   → qué tenants pertenecen a qué grupo (main/branch)
--   - fe_plans               → catálogo de planes FE (FE_500, FE_1000, etc.)
--   - tenant_fe_plans        → plan FE actual de cada tenant + uso del mes
--   - user_tenants           → relación N:M user ↔ tenants (un user en varios)
--
-- Vistas y funciones:
--   - group_billing(group_id)             → totales mensuales del grupo
--   - group_sales_report(group_id, ...)   → reporte consolidado de ventas
-- ============================================================================

-- ── 1. tenant_groups ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tenant_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  owner_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  billing_email text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_groups_owner ON public.tenant_groups(owner_id);

-- ── 2. tenant_group_members ─────────────────────────────────────────────────
-- role: 'main' (matriz, máximo 1 por grupo) | 'branch' (sucursal)
CREATE TABLE IF NOT EXISTS public.tenant_group_members (
  group_id    uuid NOT NULL REFERENCES public.tenant_groups(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id)       ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'branch' CHECK (role IN ('main', 'branch')),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_tgm_tenant ON public.tenant_group_members(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tgm_group  ON public.tenant_group_members(group_id);

-- Solo 1 'main' por grupo.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tgm_one_main_per_group
  ON public.tenant_group_members(group_id) WHERE role = 'main';

-- Un tenant solo puede pertenecer a UN grupo (no podemos compartirlo).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tgm_one_group_per_tenant
  ON public.tenant_group_members(tenant_id);

-- ── 3. fe_plans (catálogo) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fe_plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,          -- 'FE_100', 'FE_500', etc.
  name           text NOT NULL,                  -- 'FE Pequeño', 'FE Mediano'
  monthly_quota  int  NOT NULL CHECK (monthly_quota > 0),
  monthly_price  numeric(10,2) NOT NULL CHECK (monthly_price >= 0),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Catálogo inicial — ajustables desde el admin.
INSERT INTO public.fe_plans (code, name, monthly_quota, monthly_price)
VALUES
  ('FE_100',  'FE Pequeño',     100,    5000),
  ('FE_500',  'FE Mediano',     500,   10000),
  ('FE_2000', 'FE Grande',     2000,   25000),
  ('FE_10000','FE Empresarial',10000,  60000)
ON CONFLICT (code) DO NOTHING;

-- ── 4. tenant_fe_plans (plan asignado por tenant) ───────────────────────────
CREATE TABLE IF NOT EXISTS public.tenant_fe_plans (
  tenant_id      uuid PRIMARY KEY REFERENCES public.tenants(id)  ON DELETE CASCADE,
  fe_plan_id     uuid NOT NULL    REFERENCES public.fe_plans(id) ON DELETE RESTRICT,
  current_usage  int  NOT NULL DEFAULT 0,
  reset_at       timestamptz NOT NULL DEFAULT date_trunc('month', now() + interval '1 month'),
  active         boolean NOT NULL DEFAULT true,
  assigned_at    timestamptz NOT NULL DEFAULT now()
);

-- ── 5. user_tenants (multi-empresa: 1 user en N tenants) ────────────────────
-- Permite que un usuario "maestro" tenga acceso a todas las sucursales del
-- grupo sin tener que crear un user por cada una.
CREATE TABLE IF NOT EXISTS public.user_tenants (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'owner',
  is_default  boolean NOT NULL DEFAULT false,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_user_tenants_user   ON public.user_tenants(user_id);
CREATE INDEX IF NOT EXISTS idx_user_tenants_tenant ON public.user_tenants(tenant_id);

-- ── 6. Backfill: cada tenant.owner_id existente queda en user_tenants ───────
-- Asegura compatibilidad: los owners actuales acceden a sus tenants vía esta tabla.
INSERT INTO public.user_tenants (user_id, tenant_id, role, is_default)
SELECT owner_id, id, 'owner', true
FROM public.tenants
WHERE owner_id IS NOT NULL
ON CONFLICT (user_id, tenant_id) DO NOTHING;

-- ── 7. Función: billing del grupo ───────────────────────────────────────────
-- Calcula totales mensuales para el dashboard del usuario maestro.
CREATE OR REPLACE FUNCTION public.group_billing(p_group_id uuid)
RETURNS TABLE(
  group_id         uuid,
  group_name       text,
  branches         int,
  saas_per_branch  numeric,
  saas_total       numeric,
  fe_total         numeric,
  grand_total      numeric
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  -- Precio default del SaaS por sucursal. Si querés tarifa custom por grupo,
  -- agregá una columna `saas_unit_price` en `tenant_groups` y leéla acá.
  v_saas_unit numeric := 15000;
BEGIN
  RETURN QUERY
  SELECT
    tg.id,
    tg.name,
    COUNT(tgm.tenant_id)::int                                  AS branches,
    v_saas_unit                                                AS saas_per_branch,
    (COUNT(tgm.tenant_id) * v_saas_unit)::numeric              AS saas_total,
    COALESCE(SUM(fp.monthly_price), 0)::numeric                AS fe_total,
    ((COUNT(tgm.tenant_id) * v_saas_unit) + COALESCE(SUM(fp.monthly_price), 0))::numeric AS grand_total
  FROM tenant_groups tg
  LEFT JOIN tenant_group_members tgm ON tgm.group_id  = tg.id
  LEFT JOIN tenant_fe_plans      tfp ON tfp.tenant_id = tgm.tenant_id AND tfp.active
  LEFT JOIN fe_plans             fp  ON fp.id         = tfp.fe_plan_id
  WHERE tg.id = p_group_id
  GROUP BY tg.id, tg.name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.group_billing(uuid) TO authenticated;

-- ── 8. Función: reporte consolidado de ventas ───────────────────────────────
CREATE OR REPLACE FUNCTION public.group_sales_report(
  p_group_id uuid,
  p_from     timestamptz,
  p_to       timestamptz
)
RETURNS TABLE(
  tenant_id   uuid,
  tenant_name text,
  invoices    bigint,
  ventas      numeric,
  iva         numeric
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Solo el owner del grupo puede consultar el reporte consolidado.
  IF NOT EXISTS (
    SELECT 1 FROM tenant_groups
    WHERE id = p_group_id AND owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'No autorizado: no sos owner de este grupo';
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.name,
    COUNT(i.id)             AS invoices,
    COALESCE(SUM(i.total), 0)       AS ventas,
    COALESCE(SUM(i.tax_amount), 0)  AS iva
  FROM tenant_group_members tgm
  JOIN tenants t   ON t.id = tgm.tenant_id
  LEFT JOIN invoices i ON i.tenant_id = t.id
                       AND i.status = 'completed'
                       AND i.issued_at BETWEEN p_from AND p_to
  WHERE tgm.group_id = p_group_id
  GROUP BY t.id, t.name
  ORDER BY ventas DESC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION public.group_sales_report(uuid, timestamptz, timestamptz) TO authenticated;

-- ── 9. Función: tenants accesibles para el user actual ─────────────────────
-- El frontend usa esto para poblar el TenantSwitcher. Trae todos los tenants
-- del usuario vía user_tenants (no más filtrado por owner_id).
CREATE OR REPLACE FUNCTION public.my_tenants()
RETURNS TABLE(
  tenant_id     uuid,
  tenant_name   text,
  is_demo       boolean,
  status        text,
  role          text,
  is_default    boolean,
  joined_at     timestamptz,
  group_id      uuid,
  group_name    text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id, t.name, t.is_demo, t.status,
    ut.role, ut.is_default, ut.joined_at,
    tg.id, tg.name
  FROM user_tenants ut
  JOIN tenants t ON t.id = ut.tenant_id
  LEFT JOIN tenant_group_members tgm ON tgm.tenant_id = t.id
  LEFT JOIN tenant_groups        tg  ON tg.id = tgm.group_id
  WHERE ut.user_id = auth.uid()
  ORDER BY ut.is_default DESC, t.name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.my_tenants() TO authenticated;

-- ── 10. Updated_at trigger para tenant_groups ──────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS touch_tenant_groups_ua ON public.tenant_groups;
CREATE TRIGGER touch_tenant_groups_ua
  BEFORE UPDATE ON public.tenant_groups
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 11. RLS — basic (el SDK del backend usa service role y bypasea) ────────
ALTER TABLE public.tenant_groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_fe_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_tenants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fe_plans             ENABLE ROW LEVEL SECURITY;

-- Owners ven sus grupos.
DROP POLICY IF EXISTS group_owner_read ON public.tenant_groups;
CREATE POLICY group_owner_read ON public.tenant_groups
  FOR SELECT USING (owner_id = auth.uid());

-- Owners modifican sus grupos.
DROP POLICY IF EXISTS group_owner_write ON public.tenant_groups;
CREATE POLICY group_owner_write ON public.tenant_groups
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- user_tenants: el user solo ve sus propias filas.
DROP POLICY IF EXISTS ut_self_read ON public.user_tenants;
CREATE POLICY ut_self_read ON public.user_tenants
  FOR SELECT USING (user_id = auth.uid());

-- fe_plans: todos los autenticados pueden leer el catálogo (es info pública).
DROP POLICY IF EXISTS fe_plans_read ON public.fe_plans;
CREATE POLICY fe_plans_read ON public.fe_plans FOR SELECT USING (true);

-- tenant_fe_plans: el owner del tenant puede ver el suyo.
DROP POLICY IF EXISTS tfp_owner_read ON public.tenant_fe_plans;
CREATE POLICY tfp_owner_read ON public.tenant_fe_plans
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM tenants WHERE id = tenant_id AND owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM user_tenants WHERE user_id = auth.uid() AND tenant_id = tenant_fe_plans.tenant_id)
  );

-- ============================================================================
-- FIN migration 13_tenant_groups.sql
-- ============================================================================
