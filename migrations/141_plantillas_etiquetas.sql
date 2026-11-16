-- 141 · LAS PLANTILLAS DE ETIQUETAS, EN LA BASE
--
-- Vivían en el localStorage del navegador, «rápido para iterar el diseño»
-- —así quedó escrito en el servicio—. El costo de eso lo paga el negocio:
--
--   · La plantilla existe en UNA computadora. La del mostrador no la ve, y el
--     que imprime desde la bodega tiene que volver a diseñarla.
--   · Se borra con el caché del navegador, con una sesión privada o cuando
--     alguien «limpia» la computadora. Sin aviso y sin forma de recuperarla.
--   · Diseñar una etiqueta de 40×30 con su código de barras bien puesto toma
--     media hora; perderla por limpiar el navegador es media hora tirada.
--
-- Son del NEGOCIO, no del equipo. Acá quedan.
--
-- `elements` va como JSONB porque es un diseño: posiciones, tamaños, fuentes,
-- rotaciones y hasta imágenes en base64. Normalizarlo en columnas obligaría a
-- una migración cada vez que el editor aprende algo nuevo, y no se consulta por
-- partes: se lee la plantilla entera para dibujarla.

CREATE TABLE IF NOT EXISTS public.label_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  width_mm    NUMERIC NOT NULL,
  height_mm   NUMERIC NOT NULL,
  /* El borde de toda la etiqueta: separado de los elementos porque es de la
     etiqueta, no de lo que lleva adentro. */
  border      BOOLEAN NOT NULL DEFAULT FALSE,
  elements    JSONB   NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- La consulta es siempre «las plantillas de este negocio, la última primero».
CREATE INDEX IF NOT EXISTS idx_label_templates_tenant
  ON public.label_templates (tenant_id, updated_at DESC);

COMMENT ON TABLE public.label_templates IS
  'Plantillas de etiquetas de producto. Antes vivían en el localStorage del navegador.';
COMMENT ON COLUMN public.label_templates.elements IS
  'Diseño completo: posiciones, tamaños, fuentes, rotaciones e imágenes. Se lee entero.';

NOTIFY pgrst, 'reload schema';
