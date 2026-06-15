-- ============================================================================
-- 14_fix_admin_get_owners.sql — Reconciliar versión de admin_get_owners
-- ============================================================================
-- El frontend (CreateOwner.tsx) espera columnas: owner_id, is_demo, sub_id,
-- sub_plan_id, sub_status, started_at, ends_at.
-- La migration 01 vieja retornaba email, plan_name, plan_price... (mismatch).
-- Esta migration DROP + CREATE con la signature correcta.
-- ============================================================================

DROP FUNCTION IF EXISTS public.admin_get_owners() CASCADE;

CREATE FUNCTION public.admin_get_owners()
RETURNS TABLE(
  id              uuid,
  name            text,
  owner_id        uuid,
  is_demo         boolean,
  status          text,
  created_at      timestamptz,
  plan_id         uuid,
  subscription_id uuid,
  sub_id          uuid,
  sub_plan_id     uuid,
  sub_status      text,
  started_at      timestamptz,
  ends_at         timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    t.id, t.name, t.owner_id, t.is_demo, t.status,
    t.created_at, t.plan_id, t.subscription_id,
    s.id         AS sub_id,
    s.plan_id    AS sub_plan_id,
    s.status     AS sub_status,
    s.started_at,
    s.ends_at
  FROM tenants t
  LEFT JOIN LATERAL (
    SELECT * FROM subscriptions
    WHERE tenant_id = t.id
    ORDER BY created_at DESC
    LIMIT 1
  ) s ON true
  ORDER BY t.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.admin_get_owners() TO authenticated;
