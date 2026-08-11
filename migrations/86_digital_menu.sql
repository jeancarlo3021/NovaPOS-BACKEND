-- Menú digital con QR.
--
-- Una página pública, sin sesión, que el cliente abre escaneando el código de la
-- mesa. No es una copia del catálogo: el negocio elige QUÉ aparece y CÓMO se ve,
-- porque un menú es material de venta y el catálogo de inventario no.
--
-- Un menú por negocio. Si algún día hacen falta varios (almuerzo / cena / bar),
-- se agrega una columna `kind` y se quita el PK sobre tenant_id — pero armar hoy
-- una tabla para varios menús que nadie pidió solo complica el editor.
CREATE TABLE IF NOT EXISTS public.digital_menus (
  tenant_id   UUID PRIMARY KEY,

  -- Parte visible del enlace: /m/<slug>. Se genera del nombre del negocio y
  -- puede editarse. Es único en toda la instalación porque la página pública no
  -- tiene sesión con la cual desambiguar a qué negocio pertenece.
  slug        TEXT NOT NULL UNIQUE,

  -- Sin publicar, la página pública responde 404. Así se puede armar el menú con
  -- calma sin que un QR ya impreso muestre algo a medio hacer.
  published   BOOLEAN NOT NULL DEFAULT false,

  theme       TEXT NOT NULL DEFAULT 'clasico',

  -- Identidad: nombre, lema, logo, portada y datos de contacto.
  header      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Ajustes del diseño: color de acento, tipografía, si se muestran fotos,
  -- alérgenos, etiquetas de dieta y precios.
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Secciones del menú: [{ id, title, note, product_ids: [] }].
  -- El ORDEN del arreglo es el orden en que se muestran, y el de `product_ids`
  -- el de los platos dentro de cada una. Guardar el orden acá y no un campo
  -- `sort` por fila es lo que permite reordenar arrastrando sin renumerar nada.
  sections    JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Cuántas veces se abrió la página. Sirve para saber si los QR de las mesas
  -- se están usando o están de adorno.
  views       BIGINT NOT NULL DEFAULT 0,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_digital_menus_slug ON public.digital_menus (slug) WHERE published;

NOTIFY pgrst, 'reload schema';
