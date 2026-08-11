-- Recetas: unidades, consumo de inventario, costo histórico, extras y producción.
--
-- ── Por qué todo es ADITIVO ────────────────────────────────────────────────
-- Las recetas ya están en uso como ficha de costos. Nada de esto cambia el
-- comportamiento actual por sí solo: las columnas nuevas nacen NULL y las tablas
-- nuevas nacen vacías, y cada función se enciende con su propia bandera de plan.
-- Un negocio que hoy tiene recetas y no activa nada sigue viendo exactamente lo
-- mismo que antes de correr esta migración.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. UNIDADES DE MEDIDA Y CONVERSIÓN
-- ══════════════════════════════════════════════════════════════════════════
--
-- El problema que resuelve: el costo se calculaba `cost_price × cantidad` sin
-- mirar la unidad, y `recipe_ingredients.unit` era texto libre que no entraba en
-- ningún cálculo. Un producto costeado por KILO con un ingrediente de "200 g"
-- daba el costo de 200 kilos. Cualquier receta que mezclara unidad de compra con
-- unidad de porción estaba mil veces mal.
--
-- La solución es un catálogo cerrado con factor a una unidad BASE por dimensión
-- (masa → gramo, volumen → mililitro, conteo → unidad). Convertir es multiplicar
-- por el factor; comparar dimensiones distintas se rechaza.
CREATE TABLE IF NOT EXISTS public.measure_units (
  code       TEXT PRIMARY KEY,           -- 'kg', 'g', 'l', 'ml', 'und'
  name       TEXT NOT NULL,
  dimension  TEXT NOT NULL,              -- 'mass' | 'volume' | 'count'
  to_base    NUMERIC NOT NULL            -- cuántas unidades base es una de estas
);

INSERT INTO public.measure_units (code, name, dimension, to_base) VALUES
  ('g',    'Gramo',      'mass',   1),
  ('kg',   'Kilogramo',  'mass',   1000),
  ('mg',   'Miligramo',  'mass',   0.001),
  ('lb',   'Libra',      'mass',   453.592),
  ('oz',   'Onza',       'mass',   28.3495),
  ('ml',   'Mililitro',  'volume', 1),
  ('l',    'Litro',      'volume', 1000),
  ('taza', 'Taza',       'volume', 240),
  ('cda',  'Cucharada',  'volume', 15),
  ('cdta', 'Cucharadita','volume', 5),
  ('und',  'Unidad',     'count',  1),
  ('doc',  'Docena',     'count',  12)
ON CONFLICT (code) DO NOTHING;

-- En qué unidad está expresado el `cost_price` del producto. NULL = no se sabe,
-- y entonces el costeo se comporta como siempre (multiplicación directa): así
-- las recetas ya cargadas no cambian de costo de un día para otro sin que nadie
-- lo haya pedido.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS recipe_unit_code TEXT REFERENCES public.measure_units(code);

-- Unidad del ingrediente, ahora del catálogo. La columna `unit` de texto libre
-- se deja intacta: sirve de referencia de lo que el cocinero escribió y permite
-- migrar sin perder nada.
ALTER TABLE public.recipe_ingredients
  ADD COLUMN IF NOT EXISTS unit_code TEXT REFERENCES public.measure_units(code);

-- Unidad del rendimiento de la receta (para poder consumir subrecetas por peso o
-- volumen y no solo por "porción").
ALTER TABLE public.recipes
  ADD COLUMN IF NOT EXISTS yield_unit_code TEXT REFERENCES public.measure_units(code);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. CONSUMO DE INVENTARIO AL VENDER
-- ══════════════════════════════════════════════════════════════════════════
--
-- Hasta ahora vender un plato descontaba el stock del PLATO (que suele ser
-- infinito y no significa nada) y jamás tocaba el arroz ni el pollo. Acá queda
-- el registro de lo que cada venta consumió de verdad, ingrediente por
-- ingrediente: es lo que permite comparar el consumo TEÓRICO con el real y ver
-- merma, robo o mala porción.
--
-- Se guarda el detalle y no solo el descuento de stock a propósito: sin la
-- bitácora, una receta que se edita después vuelve irreconstruible lo que se
-- consumió ayer.
CREATE TABLE IF NOT EXISTS public.recipe_consumptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  invoice_id    UUID,                    -- venta que lo originó (NULL = producción)
  production_id UUID,                    -- lote de producción que lo originó
  recipe_id     UUID,
  product_id    UUID NOT NULL,           -- ingrediente consumido
  quantity      NUMERIC NOT NULL,        -- cantidad en la unidad del producto
  unit_code     TEXT,
  unit_cost     NUMERIC NOT NULL DEFAULT 0,   -- costo unitario AL MOMENTO
  total_cost    NUMERIC NOT NULL DEFAULT 0,
  reverted_at   TIMESTAMPTZ,             -- anulación de la venta → se devolvió
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recipe_cons_tenant  ON public.recipe_consumptions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recipe_cons_invoice ON public.recipe_consumptions (invoice_id);
CREATE INDEX IF NOT EXISTS idx_recipe_cons_product ON public.recipe_consumptions (tenant_id, product_id);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. COSTO CONGELADO EN LA VENTA
-- ══════════════════════════════════════════════════════════════════════════
--
-- El costo se recalculaba siempre con el `cost_price` de HOY, así que una venta
-- de hace tres meses se recosteaba con el precio actual y el food cost histórico
-- era ficción. Esto lo congela en el momento de vender.
--
-- Es la parte más urgente de todas aunque parezca la más chica: cada día que
-- pasa sin guardarlo son datos que ya no se pueden reconstruir.
ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS unit_cost  NUMERIC,   -- costo unitario al vender
  ADD COLUMN IF NOT EXISTS total_cost NUMERIC;   -- unit_cost × cantidad

-- ══════════════════════════════════════════════════════════════════════════
-- 4. EXTRAS CON INGREDIENTE
-- ══════════════════════════════════════════════════════════════════════════
--
-- Los modificadores solo tenían `price_delta`: "+ queso ₡500" sumaba ingreso
-- pero no descontaba queso ni sabía cuánto costaba. Un extra puede tener margen
-- NEGATIVO sin que nadie se entere.
--
-- Una opción puede consumir un producto de inventario o una subreceta, igual que
-- un ingrediente de receta.
CREATE TABLE IF NOT EXISTS public.modifier_ingredients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  modifier_id   UUID NOT NULL REFERENCES public.product_modifiers(id) ON DELETE CASCADE,
  type          TEXT NOT NULL DEFAULT 'product',   -- 'product' | 'subrecipe'
  product_id    UUID,
  sub_recipe_id UUID,
  quantity      NUMERIC NOT NULL DEFAULT 0,
  unit_code     TEXT REFERENCES public.measure_units(code),
  waste_pct     NUMERIC NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_modifier_ing ON public.modifier_ingredients (modifier_id);
CREATE INDEX IF NOT EXISTS idx_modifier_ing_tenant ON public.modifier_ingredients (tenant_id);

-- ══════════════════════════════════════════════════════════════════════════
-- 5. PRODUCCIÓN DE SUBRECETAS
-- ══════════════════════════════════════════════════════════════════════════
--
-- Una subreceta no tenía stock propio: o se descontaban sus ingredientes al
-- vender cada plato (y la salsa nunca existía como inventario), o había que
-- llevarla a mano. Un lote de producción consume los ingredientes de una vez y
-- deja el resultado disponible como producto.
--
-- `output_product_id` es el producto de inventario que representa la
-- preparación. Sin él no hay dónde acumular el rendimiento.
CREATE TABLE IF NOT EXISTS public.recipe_productions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  recipe_id         UUID NOT NULL REFERENCES public.recipes(id),
  output_product_id UUID,
  batches           NUMERIC NOT NULL DEFAULT 1,   -- cuántas veces la receta
  yield_qty         NUMERIC NOT NULL DEFAULT 0,   -- rendimiento total obtenido
  yield_unit_code   TEXT,
  total_cost        NUMERIC NOT NULL DEFAULT 0,
  unit_cost         NUMERIC NOT NULL DEFAULT 0,   -- costo por unidad de rendimiento
  status            TEXT NOT NULL DEFAULT 'done', -- 'done' | 'cancelled'
  notes             TEXT,
  produced_by       UUID,
  produced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recipe_prod_tenant ON public.recipe_productions (tenant_id, produced_at DESC);

-- Producto de inventario donde se acumula el rendimiento de una subreceta.
ALTER TABLE public.recipes
  ADD COLUMN IF NOT EXISTS output_product_id UUID;

NOTIFY pgrst, 'reload schema';
