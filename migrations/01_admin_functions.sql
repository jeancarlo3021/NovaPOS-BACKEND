-- SECURITY DEFINER function to get all owners (for admin panel)
-- Callable only by authenticated users with appropriate permissions
DROP FUNCTION IF EXISTS admin_get_owners() CASCADE;

CREATE FUNCTION admin_get_owners()
RETURNS TABLE (
  id UUID,
  name TEXT,
  email TEXT,
  status TEXT,
  plan_id UUID,
  plan_name TEXT,
  plan_price NUMERIC,
  plan_billing_cycle TEXT,
  subscription_id UUID,
  subscription_status TEXT,
  subscription_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT
    t.id,
    t.name,
    u.email,
    t.status,
    sp.id,
    sp.name,
    sp.price,
    sp.billing_cycle,
    s.id,
    s.status,
    s.ends_at,
    t.created_at,
    t.updated_at
  FROM tenants t
  LEFT JOIN auth.users u ON t.owner_id = u.id
  LEFT JOIN subscription_plans sp ON t.plan_id = sp.id
  LEFT JOIN subscriptions s ON t.subscription_id = s.id
  ORDER BY t.created_at DESC;
$$ IMMUTABLE;

-- SECURITY DEFINER function to renew a subscription
-- Parameters:
--   p_tenant_id: UUID of the tenant
--   p_plan_id: UUID of the new plan
--   p_ends_at: timestamp when subscription should end
DROP FUNCTION IF EXISTS admin_renew_subscription(UUID, UUID, TIMESTAMPTZ) CASCADE;

CREATE FUNCTION admin_renew_subscription(
  p_tenant_id UUID,
  p_plan_id UUID,
  p_ends_at TIMESTAMPTZ
)
RETURNS TABLE (
  subscription_id UUID,
  status TEXT,
  ends_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_subscription_id UUID;
BEGIN
  -- Create new subscription
  INSERT INTO subscriptions (tenant_id, plan_id, status, started_at, ends_at, created_at)
  VALUES (p_tenant_id, p_plan_id, 'active', NOW(), p_ends_at, NOW())
  RETURNING id INTO v_subscription_id;

  -- Update tenant to use this subscription
  UPDATE tenants
  SET subscription_id = v_subscription_id, updated_at = NOW()
  WHERE id = p_tenant_id;

  RETURN QUERY
  SELECT
    subscriptions.id,
    subscriptions.status,
    subscriptions.ends_at
  FROM subscriptions
  WHERE subscriptions.id = v_subscription_id;
END;
$$ VOLATILE;
