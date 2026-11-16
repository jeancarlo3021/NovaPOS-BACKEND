-- ═══════════════════════════════════════════════════════════════════════════
-- PLANES 2026 (Básico · Pro · Empresarial · Distribución y ruta) Y EXTRAS.
--
-- Qué hace:
--   1. Crea los planes NUEVOS como filas nuevas. NO edita los planes viejos:
--      cambiarle las `features` a un plan existente se las cambia al instante a
--      todos los negocios que lo tienen.
--   2. Marca los planes públicos viejos como `is_active = false` para que no
--      se vendan más. Eso NO le quita nada a quien ya los tiene: hoy
--      `is_active` no se usa para dar ni quitar acceso.
--   3. Crea el catálogo de EXTRAS (`plan_extras`) y la función
--      `aplicar_extra(tenant, extra)` para sumarle un extra a un negocio.
--
-- Qué NO hace:
--   · No mueve a ningún cliente de plan ni le cambia el precio. Eso va aparte,
--     cliente por cliente, con `custom_price` (precio fundador).
--   · El RELOJ MARCADOR queda en el catálogo pero INACTIVO: el botón «Marcar
--     hora» hoy solo aparece con la bandera `hr`. Hasta que el frontend mire
--     también `attendance`, activarlo no mostraría nada.
--   · La TARJETA DE PUNTOS no está: el módulo no existe todavía.
--
-- Cómo correrlo: en el editor SQL de Supabase. Probalo primero cambiando el
-- COMMIT del final por ROLLBACK y revisando lo que muestran los SELECT.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Convierte una lista de banderas en el JSON {"bandera": true, ...} que usa
-- `subscription_plans.features`.
CREATE OR REPLACE FUNCTION pg_temp.banderas(VARIADIC claves text[])
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(k, true), '{}'::jsonb) FROM unnest(claves) AS k
$$;

-- ── 1. LOS PLANES ─────────────────────────────────────────────────────────

-- Lo que trae el Básico. Los otros planes se arman sumándole a este.
CREATE TEMP TABLE _b_basico ON COMMIT DROP AS SELECT pg_temp.banderas(
  'pos','pos_card','pos_sinpe','pos_discount','pos_cash_management','pos_void_invoice',
  'pos_customer_field','pos_usd',
  'electronic_invoice','fe_pos','invoice_pdf_a4',
  'inventory','inventory_categories','inventory_unit_types','inventory_stock_view',
  'inventory_low_stock_alerts',
  'customers','proformas','returns','expenses',
  'reports','reports_basic','report_cash_sessions','report_taxes','report_vouchers',
  'settings','users','android_app'
) AS f;

CREATE TEMP TABLE _b_pro ON COMMIT DROP AS SELECT
  ((SELECT f FROM _b_basico) - 'reports_basic') || pg_temp.banderas(
  'inventory_stock_adjustments','inventory_mixed_stock','inventory_suppliers','inventory_kits',
  'purchases','supplier_returns','accounts_payable','accounts_receivable','reservations',
  'promotions','warranties','customer_portal','digital_catalog',
  'users_roles','users_shifts','labels',
  'report_advanced_sales','report_expenses','report_hourly_sales','report_product_detail',
  'report_profit','report_purchases','report_sellers','report_stock','report_stock_adjustments'
) AS f;

CREATE TEMP TABLE _b_empresarial ON COMMIT DROP AS SELECT
  (SELECT f FROM _b_pro) || pg_temp.banderas(
  'multi_branch','multi_branch_transfers','businesses_panel','accountant_portal',
  'hr','users_teams','users_activity','advanced_reports',
  'integrations','api_access','webhooks','priority_support',
  'unlimited_users','unlimited_products'
) AS f;

CREATE TEMP TABLE _b_distribucion ON COMMIT DROP AS SELECT
  (SELECT f FROM _b_pro) || pg_temp.banderas(
  'distribution','tracking','sales_agents','agent_orders','agent_agenda'
) AS f;

-- Un plan se crea solo si no existe otro con el mismo nombre: correr esto dos
-- veces no duplica nada.
INSERT INTO subscription_plans (name, description, price, billing_cycle, max_users, max_products, features, is_active)
SELECT v.name, v.description, v.price, 'monthly', v.max_users, v.max_products, v.features, true
FROM (VALUES
  ('Plan Básico',      'Empezá a vender y facturar. 1 sucursal · 2 usuarios.',
     14900, 2,      500,  (SELECT f FROM _b_basico)),
  ('Plan Pro',         'Controlá tu negocio. 1 sucursal · 5 usuarios. Etiquetadora incluida.',
     24900, 5,      2000, (SELECT f FROM _b_pro)),
  ('Plan Empresarial', 'Crecé sin perder el control. 2 sucursales · usuarios ilimitados.',
     49900, 999999, NULL, (SELECT f FROM _b_empresarial)),
  ('Plan Distribución y ruta', 'Todo el Pro + ruteo, cobro en ruta y agentes de venta.',
     34900, 10,     2000, (SELECT f FROM _b_distribucion))
) AS v(name, description, price, max_users, max_products, features)
WHERE NOT EXISTS (SELECT 1 FROM subscription_plans p WHERE p.name = v.name);

-- Productos que se venden solos (puerta de entrada).
INSERT INTO subscription_plans (name, description, price, billing_cycle, max_users, max_products, features, is_active)
SELECT 'Solo Etiquetas', 'Etiquetadora sin punto de venta: productos e impresión de etiquetas.',
       4900, 'monthly', 2, 2000,
       pg_temp.banderas('labels','inventory','inventory_products_only','inventory_categories','settings','users'),
       true
WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE name = 'Solo Etiquetas');

-- ── 2. LOS PLANES VIEJOS dejan de venderse ────────────────────────────────
-- Solo los públicos. No se tocan: demos («Demo · …»), Admin, Contador, Fe solo
-- ni Restaurante. Quien ya los tiene sigue exactamente igual.
UPDATE subscription_plans
   SET is_active = false, updated_at = now()
 WHERE name IN ('Básico','basico fe con inventario','basico fe sin inventario',
                'Profesional','Rastreo','Empresarial','Plan Sucursales');

-- ── 3. EXTRAS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plan_extras (
  code             text PRIMARY KEY,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  price_monthly    numeric(12,2) NOT NULL DEFAULT 0,
  price_yearly     numeric(12,2),
  features         jsonb NOT NULL DEFAULT '{}'::jsonb,
  /** Planes (por nombre) que ya lo traen: ahí no se cobra aparte. */
  included_in      text[] NOT NULL DEFAULT '{}',
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Qué extras tiene cada negocio y a qué precio se le vendió.
CREATE TABLE IF NOT EXISTS tenant_extras (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  extra_code   text NOT NULL REFERENCES plan_extras(code),
  price        numeric(12,2),
  started_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, extra_code)
);

INSERT INTO plan_extras (code, name, description, price_monthly, price_yearly, features, included_in, is_active) VALUES
  ('etiquetadora', 'Etiquetadora',
   'Diseño e impresión de etiquetas con precio, código de barras y QR.',
   2900, 29000, pg_temp.banderas('labels'),
   ARRAY['Plan Pro','Plan Empresarial','Plan Distribución y ruta','Solo Etiquetas'], true),
  ('restaurante', 'Paquete Restaurantes y sodas',
   'Mesas, mesa y menú digital con QR, recetas, modificadores, pedidos de mostrador, domicilio y kiosko.',
   7500, 75000, pg_temp.banderas(
     'restaurant','tables','table_orders','modifiers','digital_menu','mesa_digital','window_service',
     'pos_kiosk','pos_delivery','recipes','recipe_units','recipe_inventory','recipe_consumption',
     'recipe_cost_history','recipe_production','recipe_stations','restaurant_menu_recipes'),
   ARRAY[]::text[], true),
  ('reloj_marcador', 'Reloj marcador',
   'Entrada y salida con código o huella; horas para la planilla.',
   2900, 29000, pg_temp.banderas('attendance'),
   ARRAY['Plan Pro','Plan Empresarial','Plan Distribución y ruta'],
   false)   -- INACTIVO hasta que el frontend use la bandera `attendance`.
ON CONFLICT (code) DO NOTHING;

-- ── aplicar_extra(tenant, extra) ──────────────────────────────────────────
-- Las banderas de un negocio salen de SU plan. Para sumarle un extra sin
-- tocar al resto de los negocios de ese plan, el negocio pasa a una COPIA
-- personal del plan («<plan> · <negocio>»), igual que ya se hace con las
-- demos. Si ya tiene copia personal, se le suma a esa.
--
-- No cambia el precio: el cobro del extra queda anotado en `tenant_extras`.
CREATE OR REPLACE FUNCTION aplicar_extra(p_tenant uuid, p_extra text, p_precio numeric DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_extra    plan_extras%ROWTYPE;
  v_sub      subscriptions%ROWTYPE;
  v_plan     subscription_plans%ROWTYPE;
  v_negocio  text;
  v_nombre   text;
  v_plan_id  uuid;
BEGIN
  SELECT * INTO v_extra FROM plan_extras WHERE code = p_extra;
  IF NOT FOUND THEN RAISE EXCEPTION 'Extra % no existe', p_extra; END IF;
  IF NOT v_extra.is_active THEN RAISE EXCEPTION 'El extra % está inactivo', p_extra; END IF;

  SELECT * INTO v_sub FROM subscriptions
   WHERE tenant_id = p_tenant ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'El negocio no tiene suscripción'; END IF;

  SELECT * INTO v_plan FROM subscription_plans WHERE id = v_sub.plan_id;
  SELECT name INTO v_negocio FROM tenants WHERE id = p_tenant;

  IF v_plan.name = ANY (v_extra.included_in) THEN
    RAISE NOTICE 'El plan % ya incluye %; no se hace nada', v_plan.name, v_extra.name;
    RETURN v_plan.id;
  END IF;

  v_nombre := v_plan.name || ' · ' || v_negocio;

  IF v_plan.name = v_nombre THEN
    -- Ya es su copia personal: se le suman las banderas.
    UPDATE subscription_plans
       SET features = features || v_extra.features, updated_at = now()
     WHERE id = v_plan.id;
    v_plan_id := v_plan.id;
  ELSE
    INSERT INTO subscription_plans (name, description, price, billing_cycle, max_users, max_products, max_orders, features, is_active)
    VALUES (v_nombre, v_plan.description, v_plan.price, v_plan.billing_cycle,
            v_plan.max_users, v_plan.max_products, v_plan.max_orders,
            v_plan.features || v_extra.features, false)   -- false: no se ofrece a nadie más
    RETURNING id INTO v_plan_id;

    UPDATE subscriptions SET plan_id = v_plan_id, updated_at = now() WHERE id = v_sub.id;
    UPDATE tenants SET plan_id = v_plan_id WHERE id = p_tenant;
  END IF;

  INSERT INTO tenant_extras (tenant_id, extra_code, price)
  VALUES (p_tenant, p_extra, COALESCE(p_precio, v_extra.price_monthly))
  ON CONFLICT (tenant_id, extra_code) DO UPDATE SET price = EXCLUDED.price;

  RETURN v_plan_id;
END $$;

-- ── Revisión ──────────────────────────────────────────────────────────────
SELECT name, price, max_users, max_products, is_active,
       (SELECT count(*) FROM jsonb_object_keys(features)) AS banderas
  FROM subscription_plans
 WHERE name LIKE 'Plan %' OR name = 'Solo Etiquetas'
    OR name IN ('Básico','basico fe con inventario','basico fe sin inventario',
                'Profesional','Rastreo','Empresarial','Plan Sucursales')
 ORDER BY is_active DESC, price;

SELECT code, name, price_monthly, is_active, included_in FROM plan_extras ORDER BY code;

COMMIT;   -- ← para probar, cambialo por ROLLBACK

-- Ejemplo de uso (después de correr lo de arriba):
--   SELECT aplicar_extra('<tenant_id>', 'etiquetadora');          -- precio de lista
--   SELECT aplicar_extra('<tenant_id>', 'restaurante', 5000);     -- precio especial
