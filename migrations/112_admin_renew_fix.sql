-- RENOVACIÓN: la fecha que manda el panel es la fecha FINAL.
--
-- Síntoma: al renovar «1 mes» la suscripción quedaba vencida DOS meses después.
--
-- Causa: el panel ya calcula la fecha final (vencimiento actual + los meses
-- elegidos) y la manda en `p_ends_at`. La versión de esta función que quedó viva
-- en la base —creada a mano, nunca estuvo en las migraciones— le sumaba además
-- su propio plazo. Nadie podía verlo porque su código no estaba en el proyecto.
--
-- Acá queda definida de forma explícita: guarda EXACTAMENTE la fecha recibida,
-- sin sumarle nada. La única conversión es llevarla al final de ese día, porque
-- «vence el 13 de octubre» significa que ese día todavía se puede trabajar.
CREATE OR REPLACE FUNCTION public.admin_renew_subscription(
  p_tenant_id UUID,
  p_plan_id   UUID,
  p_ends_at   DATE
)
RETURNS TABLE (
  subscription_id UUID,
  status TEXT,
  ends_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_subscription_id UUID;
  v_ends_at TIMESTAMPTZ := (p_ends_at + INTERVAL '1 day' - INTERVAL '1 second');
BEGIN
  INSERT INTO subscriptions (tenant_id, plan_id, status, started_at, ends_at, created_at)
  VALUES (p_tenant_id, p_plan_id, 'active', NOW(), v_ends_at, NOW())
  RETURNING id INTO v_subscription_id;

  UPDATE tenants
     SET subscription_id = v_subscription_id, updated_at = NOW()
   WHERE id = p_tenant_id;

  RETURN QUERY
  SELECT s.id, s.status, s.ends_at
    FROM subscriptions s
   WHERE s.id = v_subscription_id;
END;
$$ VOLATILE;

NOTIFY pgrst, 'reload schema';
