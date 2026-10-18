-- ANUNCIOS A LOS NEGOCIOS: avisar de un módulo nuevo o de un cambio.
--
-- Hasta hoy, cuando salía algo nuevo no había forma de contarlo: el cliente se
-- enteraba de casualidad, o no se enteraba. Un módulo que nadie sabe que
-- existe es trabajo tirado.
--
-- ── Por qué se guarda el envío y no solo el texto ─────────────────────────
-- Para no repetirlo. Mandar dos veces el mismo anuncio al mismo número es la
-- forma más rápida de que a uno lo bloqueen en WhatsApp, y ahí se pierde el
-- canal para TODO lo demás: los recordatorios de pago, los comprobantes.
-- Queda registrado a quién se le mandó y cuándo.

CREATE TABLE IF NOT EXISTS public.anuncios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo      TEXT NOT NULL,
  mensaje     TEXT NOT NULL,
  -- A quién iba dirigido: planes elegidos y si incluía morosos/inactivos.
  segmento    JSONB NOT NULL DEFAULT '{}'::jsonb,
  estado      TEXT NOT NULL DEFAULT 'borrador',   -- borrador | programado | enviando | enviado | cancelado
  /**
   * Cuándo sale. NULL = ya salió o sale ahora.
   *
   * Se guarda en UTC como todo lo demás; la pantalla lo muestra en hora de
   * Costa Rica. Guardar «14:30» sin zona es el error clásico: el servidor
   * corre en UTC y el aviso saldría a las 8:30 de la mañana.
   */
  programado_para TIMESTAMPTZ,
  enviados    INTEGER NOT NULL DEFAULT 0,
  fallidos    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at     TIMESTAMPTZ
);

-- A quién le llegó cada anuncio. Una fila por negocio.
CREATE TABLE IF NOT EXISTS public.anuncio_envios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anuncio_id  UUID NOT NULL REFERENCES public.anuncios(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  telefono    TEXT,
  ok          BOOLEAN NOT NULL DEFAULT FALSE,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Evita el envío repetido del MISMO anuncio al MISMO negocio aunque alguien
-- toque «enviar» dos veces o se solapen dos corridas.
CREATE UNIQUE INDEX IF NOT EXISTS anuncio_envios_unico
  ON public.anuncio_envios (anuncio_id, tenant_id);

CREATE INDEX IF NOT EXISTS anuncio_envios_anuncio_idx
  ON public.anuncio_envios (anuncio_id);

-- Para que el trabajo programado encuentre rápido lo que le toca mandar.
CREATE INDEX IF NOT EXISTS anuncios_pendientes_idx
  ON public.anuncios (estado, programado_para);

-- ── AJUSTES GLOBALES (no son de ningún negocio) ──────────────────────────
-- Hay cosas que no pertenecen a un negocio: el tipo de cambio del día, o
-- cuánto deja cada plan. Se venían guardando en `settings` con un tenant_id de
-- ceros, y eso NUNCA funcionó: `settings.tenant_id` tiene clave foránea contra
-- `tenants`, el insert fallaba y el error quedaba atrapado en un try/catch.
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
