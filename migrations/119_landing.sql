-- LANDING PAGE PÚBLICA, editable desde el panel admin.
--
-- Hasta hoy colonclick.com abría directo el login: quien llegaba por una
-- recomendación o por una búsqueda no tenía dónde enterarse de qué es esto ni
-- cómo pedirlo. Esta tabla guarda lo que se publica ahí.
--
-- ── Por qué BORRADOR y PUBLICADO separados ────────────────────────────────
-- Es una página pública. Sin esa separación, cada letra que alguien escribe
-- mientras arma un texto queda a la vista de cualquiera que entre en ese
-- momento, incluido un precio a medio corregir. Se edita el borrador y se
-- publica cuando está listo, igual que el menú digital.

CREATE TABLE IF NOT EXISTS public.landing_content (
  -- Una sola fila. La clave existe para poder tener variantes algún día
  -- (por idioma, por campaña) sin migrar nada.
  key          TEXT PRIMARY KEY DEFAULT 'default',
  draft        JSONB NOT NULL DEFAULT '{}'::jsonb,
  published    JSONB,
  published_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.landing_content (key, draft)
VALUES ('default', '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── MEDICIÓN (fase 5) ────────────────────────────────────────────────────
-- Sin saber cuánta gente entra y cuántos escriben, no hay forma de saber si la
-- página sirve. Se guarda AGREGADO POR DÍA, no visita por visita: para decidir
-- alcanza con la cuenta diaria, y guardar el rastro de cada visitante de una
-- página pública es juntar datos personales que después hay que cuidar.
CREATE TABLE IF NOT EXISTS public.landing_stats (
  dia        DATE NOT NULL,
  evento     TEXT NOT NULL,              -- 'visita' | 'formulario' | 'clic_entrar'
  origen     TEXT NOT NULL DEFAULT '',   -- dominio de procedencia, sin la ruta
  cuenta     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dia, evento, origen)
);

CREATE INDEX IF NOT EXISTS landing_stats_dia_idx ON public.landing_stats (dia DESC);

COMMENT ON TABLE public.landing_stats IS
  'Conteo diario de la landing. Agregado a propósito: no guarda IP, ni sesión, ni recorrido.';

-- ── INTERESADOS ──────────────────────────────────────────────────────────
-- Tabla propia, y conviene explicar por qué, porque la primera intención fue
-- reusar `demo_requests` y estaba mal:
--
--   · `demo_requests` exige `tenant_id` y su bandeja filtra por negocio Y por
--     `demo_tenant_id`. Un interesado de la calle no tiene negocio, así que
--     habría entrado y NO SE HABRÍA VISTO EN NINGUNA PANTALLA. Leads que nadie
--     mira es peor que no tener formulario.
--   · `leads` es el embudo de los agentes de venta DE CADA NEGOCIO (zona,
--     agente, proforma). También exige negocio y no es lo mismo.
--
-- Un interesado del landing es de la PLATAFORMA, no de un negocio. Y hay un
-- beneficio extra: la única tabla a la que le puede escribir un desconocido no
-- contiene ningún dato de ningún cliente.
CREATE TABLE IF NOT EXISTS public.landing_leads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name  TEXT,
  contact_name   TEXT NOT NULL,
  phone          TEXT,
  email          TEXT,
  business_type  TEXT,
  notes          TEXT,
  origen         TEXT,            -- de dónde venía la visita
  status         TEXT NOT NULL DEFAULT 'nuevo',   -- nuevo | contactado | convertido | descartado
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS landing_leads_estado_idx
  ON public.landing_leads (status, created_at DESC);

COMMENT ON TABLE public.landing_leads IS
  'Interesados que escribieron desde la página pública. No pertenecen a ningún negocio: son de la plataforma.';

NOTIFY pgrst, 'reload schema';
