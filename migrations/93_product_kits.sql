-- 93 · Kits de productos (combos / paquetes).
--
-- Un kit ES un producto vendible normal (aparece en el POS, tiene precio y
-- CABYS propios) que por dentro está armado con otros productos. Al venderlo se
-- descuenta el stock de sus COMPONENTES, no el del kit — igual que una receta,
-- pero para retail: "combo 6 cervezas", "canasta navideña", "kit de frenos".

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_kit BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.product_kit_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  -- Producto que se vende (el kit).
  kit_id       UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  -- Producto que se descuenta del inventario.
  component_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  quantity     NUMERIC(14,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_kit_items_kit
  ON public.product_kit_items (tenant_id, kit_id);
CREATE INDEX IF NOT EXISTS product_kit_items_component
  ON public.product_kit_items (tenant_id, component_id);
-- Un componente no se repite dentro del mismo kit: se suma la cantidad.
CREATE UNIQUE INDEX IF NOT EXISTS product_kit_items_unique
  ON public.product_kit_items (kit_id, component_id);

CREATE INDEX IF NOT EXISTS products_is_kit
  ON public.products (tenant_id) WHERE is_kit = true;

NOTIFY pgrst, 'reload schema';
