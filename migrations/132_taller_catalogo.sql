-- 132 · CATÁLOGO DEL TALLER Y COBRO DEL ENVÍO
--
-- Dos cosas que faltaban para que anotar una venta no sea escribir todo de
-- nuevo cada vez:
--
--  · El CATÁLOGO: lo que el taller vende, con su precio. Un artículo puede
--    tener VARIOS precios —el mismo llavero vale distinto en chico que en
--    grande, en PLA que en resina—, así que los precios van en una lista y no
--    en una sola columna. Un artículo de un solo precio simplemente tiene una.
--  · El ENVÍO: acá se cobra aparte de la pieza. Va como su propia columna en
--    la venta, no sumado al precio, porque el dueño necesita poder responder
--    «¿cuánto cobré de envíos este mes?» sin desarmar cada apunte.

-- ── Lo que vende el taller ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.taller_catalogo (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  nombre      TEXT NOT NULL,
  descripcion TEXT,
  -- impresion | diseno | material | reparacion | otro (las mismas de la venta)
  categoria   TEXT NOT NULL DEFAULT 'impresion',
  -- El precio de siempre. Si el artículo tiene variantes, es el de la primera.
  precio      NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Los otros precios del MISMO artículo: [{nombre, precio}]
  -- Ej. [{"nombre":"Chico","precio":2000},{"nombre":"Grande","precio":3500}]
  variantes   JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Cuánto tarda imprimirlo. Con esto, meterlo a la cola de impresión no
  -- obliga a acordarse de las horas: se traen del catálogo.
  horas       NUMERIC(8,2),
  material    TEXT,
  color       TEXT,
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS taller_catalogo_tenant ON public.taller_catalogo (tenant_id, activo, nombre);

-- ── Lo que cuesta mandarlo ─────────────────────────────────────────────────
-- Tarifas con nombre: «Correos GAM ₡2.500», «Uber ₡3.000», «Retiro ₡0». Se
-- eligen al anotar la venta en vez de escribir el monto de memoria.
CREATE TABLE IF NOT EXISTS public.taller_envios_tarifas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,
  nombre     TEXT NOT NULL,
  monto      NUMERIC(12,2) NOT NULL DEFAULT 0,
  activo     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS taller_tarifas_tenant ON public.taller_envios_tarifas (tenant_id, activo);

-- ── La venta: de dónde salió y cuánto se cobró de envío ────────────────────
ALTER TABLE public.taller_ventas
  ADD COLUMN IF NOT EXISTS producto_id UUID REFERENCES public.taller_catalogo(id) ON DELETE SET NULL,
  -- Qué variante se vendió, como texto: si mañana cambia el catálogo, el
  -- apunte viejo tiene que seguir diciendo qué fue lo que se vendió.
  ADD COLUMN IF NOT EXISTS variante TEXT,
  ADD COLUMN IF NOT EXISTS envio NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS envio_etiqueta TEXT;

COMMENT ON COLUMN public.taller_ventas.envio IS 'Cobro del envío, aparte del precio de la pieza';
COMMENT ON COLUMN public.taller_ventas.total IS 'cantidad × precio_unitario + envio';

-- ── La impresión también puede venir del catálogo ──────────────────────────
ALTER TABLE public.impresiones
  ADD COLUMN IF NOT EXISTS producto_id UUID REFERENCES public.taller_catalogo(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
