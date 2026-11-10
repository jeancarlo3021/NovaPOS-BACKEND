-- 138 · PROMOCIÓN CON REGALÍA: «llevate esto y te regalo aquello»
--
-- Las promos que había cambian el PRECIO de lo que el cliente compra: un
-- porcentaje, un monto, un combo a precio fijo, la segunda a mitad. La regalía
-- es otra cosa: el precio de lo comprado no se toca y se suma un artículo que
-- sale en cero.
--
-- Es la promo que más se usa en pulpería y restaurante —«comprá el combo y te
-- va el refresco», «dos pizzas y la gaseosa va de cortesía»— y no se podía
-- armar: con un combo a precio fijo había que calcular a mano cuánto bajaba el
-- total para que el regalo saliera gratis, y el tiquete nunca decía que hubo
-- un regalo.
--
-- ── Qué se guarda ─────────────────────────────────────────────────────────
-- `product_ids` (que ya existe) es lo que hay que COMPRAR: uno solo para «un
-- artículo», varios para «un conjunto». Acá se agrega qué se regala:
--
--     gift_product_id → el artículo de cortesía
--     gift_qty        → cuántos, por cada vez que se cumple la compra
--
-- El regalo se guarda como producto y no como texto libre a propósito: tiene
-- que salir en la factura con su línea, su CAByS y su precio en cero. Un
-- «regalo» que solo existe en el nombre de la promo no descuenta inventario y
-- no se puede contar después.

ALTER TABLE public.promotions
  ADD COLUMN IF NOT EXISTS gift_product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gift_qty        NUMERIC;

COMMENT ON COLUMN public.promotions.gift_product_id IS
  'Artículo que se regala al cumplir la compra (promos type=gift).';
COMMENT ON COLUMN public.promotions.gift_qty IS
  'Cuántas unidades se regalan por cada vez que se cumple la compra. Por omisión 1.';

NOTIFY pgrst, 'reload schema';
