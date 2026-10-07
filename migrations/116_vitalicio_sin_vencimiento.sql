-- ─────────────────────────────────────────────────────────────────────────────
-- Un plan VITALICIO no lleva fecha de vencimiento.
--
-- Quedaron suscripciones de planes vitalicios —«Fe solo»— con un `ends_at`
-- guardado, de cuando la fecha se calculaba sin mirar el ciclo del plan: se les
-- sumaban días como si fueran mensuales o anuales. Efectos que ya se veían o
-- iban a verse:
--
--   · el panel mostraba una fecha de vencimiento en una cuenta que no vence;
--   · al llegar esa fecha, el middleware pasaba el negocio a SOLO LECTURA y no
--     podía facturar;
--   · se le mandaba aviso de cobro por WhatsApp a quien no debe nada.
--
-- El código ya hace mandar el ciclo del plan sobre la fecha guardada (ver
-- src/utils/planCiclo.ts, middleware/tenantStatus.ts y services/paymentReminders.ts),
-- así que esto es solo dejar el DATO de acuerdo con la regla.
--
-- NO toca las DEMOS ni la cuenta Admin, aunque su plan también sea vitalicio:
-- una demo vence a propósito —para eso es una prueba— y su fecha la maneja la
-- pantalla de Demos.
-- ─────────────────────────────────────────────────────────────────────────────

-- Lo que se va a cambiar (revisar antes de aplicar):
--   SELECT t.name, p.name AS plan, s.ends_at
--     FROM subscriptions s
--     JOIN subscription_plans p ON p.id = s.plan_id
--     JOIN tenants t ON t.id = s.tenant_id
--    WHERE s.status = 'active' AND s.ends_at IS NOT NULL
--      AND lower(btrim(p.billing_cycle)) = 'lifetime'
--      AND t.is_demo IS NOT TRUE
--      AND p.name NOT ILIKE '%demo%'
--      AND COALESCE((p.features->>'admin_dashboard')::boolean, false) = false;

UPDATE subscriptions s
   SET ends_at = NULL,
       updated_at = NOW()
  FROM subscription_plans p, tenants t
 WHERE p.id = s.plan_id
   AND t.id = s.tenant_id
   AND s.status = 'active'
   AND s.ends_at IS NOT NULL
   AND lower(btrim(p.billing_cycle)) = 'lifetime'
   AND t.is_demo IS NOT TRUE
   AND p.name NOT ILIKE '%demo%'
   AND COALESCE((p.features->>'admin_dashboard')::boolean, false) = false;
