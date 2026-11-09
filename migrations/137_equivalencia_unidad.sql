-- 137 · CUÁNTO PESA UNA UNIDAD
--
-- El costeo de recetas convierte entre unidades de la MISMA dimensión: kilos a
-- gramos sí, litros a mililitros sí. Pero de kilos a unidades se negaba, y con
-- razón: no hay forma de saber cuántas unidades hay en un kilo… salvo que
-- alguien lo diga.
--
-- Eso es justo lo que falta en un negocio real. El pollo se compra por kilo y
-- la receta lleva «1 pollo». El queso se compra en bloque de 5 kg y la receta
-- lleva «2 tajadas». Sin poder decir la equivalencia, esos ingredientes
-- quedaban sin costear y la ficha mentía.
--
-- Con estas dos columnas el producto declara su propia regla:
--
--     1 <recipe_unit_code> equivale a <equiv_qty> <equiv_unit_code>
--     1 unidad            equivale a 1.8         kg        (un pollo)
--     1 tajada            equivale a 25          g         (una tajada de queso)
--
-- Es por PRODUCTO y no una tabla global a propósito: no existe «el peso de una
-- unidad», existe el peso de una unidad DE ESE producto. Una tabla general
-- obligaría a inventar un promedio y el costo saldría mal para todos.
--
-- Sin la equivalencia, todo sigue como está: la conversión entre dimensiones
-- distintas se sigue negando y la pantalla lo sigue avisando.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS equiv_qty       NUMERIC,
  ADD COLUMN IF NOT EXISTS equiv_unit_code TEXT REFERENCES public.measure_units(code);

COMMENT ON COLUMN public.products.equiv_qty IS
  'Cuánto mide/pesa UNA unidad de este producto, en equiv_unit_code. Ej: 1.8 (kg por pollo).';
COMMENT ON COLUMN public.products.equiv_unit_code IS
  'La unidad de esa equivalencia. Permite convertir entre conteo y peso/volumen SOLO para este producto.';

NOTIFY pgrst, 'reload schema';
