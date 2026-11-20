-- 146 · PLANTILLAS DE DOCUMENTO: tiquete, hoja (PDF) y proforma
--
-- Hasta ahora lo único que se podía cambiar del papel eran unos interruptores
-- (mostrar logo, mostrar dirección) y el mensaje del pie. Todo lo demás —dónde
-- va el logo, qué columnas lleva el detalle, cómo se titula el documento, las
-- condiciones de una cotización— estaba escrito en el código, igual para todos.
--
-- Acá se guarda el DISEÑO, por tipo de documento:
--   'ticket'   — el tiquete de venta (rollo térmico o navegador)
--   'hoja'     — el comprobante en hoja carta/A4 (lo que se guarda como PDF)
--   'proforma' — la cotización
--
-- ── Por qué BANDAS y no un lienzo suelto ──────────────────────────────────
-- Un documento no tiene alto fijo: una venta de 3 líneas y una de 60 van en el
-- mismo diseño. Con posiciones absolutas sobre una página entera, la venta
-- larga se le monta encima a los totales o se sale del papel.
--
-- Por eso el diseño son tres bandas: ENCABEZADO (alto fijo, elementos donde el
-- negocio quiera), DETALLE (la tabla de líneas, que crece) y PIE (alto fijo).
-- Dentro de cada banda se arrastra libre; entre bandas, el detalle empuja. Así
-- el mismo diseño sirve para 3 líneas y para 60, y pagina bien en hoja.
--
-- `design` va como JSONB entero: es un diseño, se lee completo para dibujarlo y
-- el editor aprende cosas nuevas seguido. Normalizarlo en columnas obligaría a
-- una migración cada vez que se agrega una propiedad.

CREATE TABLE IF NOT EXISTS public.document_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('ticket', 'hoja', 'proforma')),
  name        TEXT NOT NULL,
  /* La que se usa al imprimir ese tipo de documento. Sin ninguna marcada, se
     imprime con el diseño de siempre: una plantilla a medio hacer no debe
     reemplazar al comprobante que ya funciona. */
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  /* Ancho del papel en mm (72 = rollo de 80mm, 216 = carta, 210 = A4) y alto
     de la hoja. En rollo el alto no existe: lo pone el contenido. */
  width_mm    NUMERIC NOT NULL DEFAULT 216,
  height_mm   NUMERIC,
  design      JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- La consulta es «las plantillas de este negocio para este tipo».
CREATE INDEX IF NOT EXISTS idx_doc_templates_tenant
  ON public.document_templates (tenant_id, kind, updated_at DESC);

/* UNA sola predeterminada por tipo, garantizado por la base.
   El servidor apaga las otras al marcar una, pero dos pestañas abiertas
   guardando a la vez dejarían dos marcadas y el documento saldría con una u
   otra según el orden de lectura — un "a veces sale distinto" imposible de
   explicarle a nadie. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_templates_una_default
  ON public.document_templates (tenant_id, kind)
  WHERE is_default;

COMMENT ON TABLE public.document_templates IS
  'Diseño del tiquete, de la hoja (PDF) y de la proforma: bandas con elementos posicionados.';
COMMENT ON COLUMN public.document_templates.design IS
  'Diseño completo (bandas, elementos, tabla, estilos). Se lee entero para dibujar.';

NOTIFY pgrst, 'reload schema';
