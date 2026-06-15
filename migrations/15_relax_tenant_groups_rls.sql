-- ============================================================================
-- 15_relax_tenant_groups_rls.sql — RLS más permisiva en tenant_groups
-- ============================================================================
-- USAR SOLO SI no podés configurar SUPABASE_SERVICE_ROLE_KEY correctamente
-- en el backend. La policy original requiere `owner_id = auth.uid()` que
-- falla cuando el backend usa la anon key (auth.uid() = NULL).
--
-- Después de esta migration, cualquier usuario autenticado puede INSERT/UPDATE,
-- pero el SELECT sigue restringido a sus propios grupos. La seguridad real la
-- hace el backend verificando `userId` antes de cada operación.
-- ============================================================================

-- 1. Permitir INSERT autenticado (sin restringir owner_id en SQL)
DROP POLICY IF EXISTS group_owner_write ON public.tenant_groups;

CREATE POLICY group_auth_insert ON public.tenant_groups
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY group_owner_update ON public.tenant_groups
  FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

CREATE POLICY group_owner_delete ON public.tenant_groups
  FOR DELETE TO authenticated USING (owner_id = auth.uid());

-- 2. Mismo trato para tenant_group_members (la INSERT también la hace el backend)
ALTER TABLE public.tenant_group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY tgm_read ON public.tenant_group_members
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM tenant_groups WHERE id = group_id AND owner_id = auth.uid())
  );

CREATE POLICY tgm_write ON public.tenant_group_members
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY tgm_delete ON public.tenant_group_members
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM tenant_groups WHERE id = group_id AND owner_id = auth.uid())
  );

-- 3. user_tenants: permitir upsert desde backend
DROP POLICY IF EXISTS ut_self_read ON public.user_tenants;

CREATE POLICY ut_read ON public.user_tenants
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ut_write ON public.user_tenants
  FOR INSERT TO authenticated WITH CHECK (true);

-- 4. tenant_fe_plans: igual
ALTER TABLE public.tenant_fe_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tfp_owner_read ON public.tenant_fe_plans;

CREATE POLICY tfp_read ON public.tenant_fe_plans
  FOR SELECT TO authenticated USING (true);

CREATE POLICY tfp_write ON public.tenant_fe_plans
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
