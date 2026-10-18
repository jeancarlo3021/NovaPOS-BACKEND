-- LO QUE LE FALTA A UNA BASE QUE YA CORRIÓ LA 120.
--
-- La migración 120 creció después de que se corriera: primero traía solo las
-- tablas de anuncios, y más tarde se le sumaron `global_settings` y la
-- programación de envíos. `CREATE TABLE IF NOT EXISTS` no agrega columnas a
-- una tabla que ya existe, así que volver a correr la 120 no alcanza.
--
-- Esta migración es idempotente: correrla dos veces no hace nada la segunda.
-- En una base nueva tampoco molesta, porque la 120 ya deja todo esto puesto.

-- ── 1. Cuándo sale cada anuncio ──────────────────────────────────────────
-- En UTC, como todo. La pantalla lo muestra en hora de Costa Rica. Guardar
-- «14:30» sin zona es el error clásico: el servidor corre en UTC y el aviso
-- saldría a las 8:30 de la mañana.
ALTER TABLE public.anuncios
  ADD COLUMN IF NOT EXISTS programado_para TIMESTAMPTZ;

COMMENT ON COLUMN public.anuncios.programado_para IS
  'Momento en que debe salir (UTC). NULL = sale de inmediato o ya salió.';

COMMENT ON COLUMN public.anuncios.estado IS
  'borrador | programado | enviando | enviado | cancelado';

-- Para que el trabajo programado encuentre rápido lo que le toca mandar.
CREATE INDEX IF NOT EXISTS anuncios_pendientes_idx
  ON public.anuncios (estado, programado_para);

-- ── 2. Ajustes que no son de ningún negocio ──────────────────────────────
-- El tipo de cambio del día y cuánto deja cada plan. Se venían guardando en
-- `settings` con un tenant_id de ceros, y eso NUNCA funcionó: esa columna
-- tiene clave foránea contra `tenants`, el insert fallaba y el error quedaba
-- atrapado en un try/catch.
--
-- Comprobado contra la base: cero filas de 'exchange-rate' guardadas. O sea
-- que el tipo de cambio del BCCR se vuelve a pedir en cada arranque y, si el
-- BCCR está caído, no hay último valor conocido al que caer — justo para lo
-- que se había escrito ese respaldo.
CREATE TABLE IF NOT EXISTS public.global_settings (
  type        TEXT PRIMARY KEY,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.global_settings IS
  'Ajustes que no son de ningún negocio: tipo de cambio del día, ingresos declarados por plan.';

NOTIFY pgrst, 'reload schema';
