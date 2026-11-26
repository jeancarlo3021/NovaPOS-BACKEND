-- INTERESADOS POR CORREO, Y LA MEDICIÓN DEL EMBUDO
--
-- Dos cosas que faltaban en la página pública.
--
-- ══ 1. EL AVISO ═══════════════════════════════════════════════════════════
-- Un interesado escribía desde la página, la fila entraba en `landing_leads`
-- y ahí se quedaba hasta que alguien se acordara de abrir el panel. El
-- formulario funcionaba y el negocio perdía el cliente igual: a las dos horas
-- ya llamó a otro.
--
-- Las dos columnas de abajo no son decorativas. Un aviso que se intentó y
-- falló tiene que poder verse: si el correo no sale —se venció la API key, el
-- dominio quedó sin verificar— sin estas columnas nadie se enterararía nunca,
-- y la pantalla seguiría diciendo que todo está bien mientras los interesados
-- se acumulan sin avisar.

ALTER TABLE public.landing_leads
  /** Cuándo salió el aviso. NULL = no salió (todavía, o nunca). */
  ADD COLUMN IF NOT EXISTS aviso_email_at    TIMESTAMPTZ,
  /** Por qué no salió. Es lo que permite arreglarlo en vez de adivinar. */
  ADD COLUMN IF NOT EXISTS aviso_email_error TEXT,
  /** A quiénes se les avisó, para poder responder «sí te llegó, revisá spam». */
  ADD COLUMN IF NOT EXISTS aviso_email_to    TEXT;

-- Los interesados a los que no se les pudo avisar: la consulta que la pantalla
-- hace para mostrar la advertencia.
CREATE INDEX IF NOT EXISTS landing_leads_sin_aviso_idx
  ON public.landing_leads (created_at DESC)
  WHERE aviso_email_at IS NULL;

-- ══ 2. LA MEDICIÓN ════════════════════════════════════════════════════════
-- `landing_stats` no necesita columnas nuevas: el evento es un TEXT y el
-- evento nuevo —`login`— entra sin tocar el esquema. Lo que sí hay que
-- cambiar es el comentario de la columna, porque la lista que tenía ya no es
-- la verdadera, y un comentario desactualizado engaña más que ninguno.
--
-- Por qué `login` es una estadística APARTE de `clic_entrar`:
--   · `clic_entrar` es que alguien tocó el botón «Entrar». Mide interés.
--   · `login` es que de verdad llegó adentro. Mide que la puerta funciona.
-- Entre los dos números está todo lo que se pierde en el camino: el que no
-- se acordó de la contraseña, el que se equivocó de usuario, el que se topó
-- con un error. Con un solo contador eso era invisible: cien clics se veían
-- igual de bien con cien ingresos que con tres.

COMMENT ON COLUMN public.landing_stats.evento IS
  'visita | formulario | clic_entrar | login. «clic_entrar» es haber tocado el botón; '
  '«login» es haber entrado de verdad. La diferencia entre los dos es lo que se '
  'pierde en el inicio de sesión.';

/**
 * EL CONTADOR, ATÓMICO.
 *
 * ── El error que tenía ───────────────────────────────────────────────────
 * El código leía la cuenta del día, le sumaba uno y la escribía. Con una
 * sola visita a la vez funciona; con dos al mismo tiempo las dos leen 7, las
 * dos escriben 8, y una visita se pierde sin que nada falle. Justo en el
 * momento en que la página empieza a tener tráfico —cuando el número importa—
 * es cuando más se desvía, y siempre hacia abajo: los informes muestran menos
 * visitas de las que hubo y nadie tiene forma de notarlo.
 *
 * `ON CONFLICT DO UPDATE SET cuenta = cuenta + 1` lo resuelve de verdad: la
 * suma la hace la base, en una sola operación, y no hay hueco entre leer y
 * escribir.
 */
CREATE OR REPLACE FUNCTION public.landing_contar(
  p_dia DATE, p_evento TEXT, p_origen TEXT
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.landing_stats (dia, evento, origen, cuenta)
  VALUES (p_dia, p_evento, COALESCE(p_origen, ''), 1)
  ON CONFLICT (dia, evento, origen)
  DO UPDATE SET cuenta = public.landing_stats.cuenta + 1;
$$;

-- La página es pública y sin sesión: el contador lo llama un anónimo.
GRANT EXECUTE ON FUNCTION public.landing_contar(DATE, TEXT, TEXT) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
