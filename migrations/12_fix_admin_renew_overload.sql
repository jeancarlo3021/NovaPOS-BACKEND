-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 12: Resolver overload duplicado de admin_renew_subscription
-- ═══════════════════════════════════════════════════════════════════════════
-- Síntoma: al renovar una suscripción Postgres responde con
--   "Could not choose the best candidate function between:
--    public.admin_renew_subscription(p_tenant_id => uuid, p_plan_id => uuid,
--                                    p_ends_at => date),
--    public.admin_renew_subscription(p_tenant_id => uuid, p_plan_id => uuid,
--                                    p_ends_at => timestamp with time zone)"
--
-- Causa: existen dos versiones de la función con la misma firma salvo el
-- tipo del último parámetro. El frontend manda un string de fecha (YYYY-MM-DD)
-- y Postgres no puede elegir cuál llamar.
--
-- Solución: nos quedamos con la versión que recibe `date` (que es lo que
-- realmente representa el dato) y eliminamos la sobrecarga de timestamptz.

DROP FUNCTION IF EXISTS public.admin_renew_subscription(uuid, uuid, timestamp with time zone);

NOTIFY pgrst, 'reload schema';
