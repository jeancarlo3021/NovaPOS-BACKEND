-- 102 · Descuentos en proformas.
--
-- Cotizar sin poder descontar obliga a bajar el precio unitario a mano: el
-- cliente no ve cuánto le rebajaron —que es justo lo que cierra la venta— y
-- después nadie sabe si ese precio fue una promoción o un error de digitación.
--
-- Se guarda el descuento GENERAL del documento; el de cada línea vive dentro de
-- `items` (discount_percent / discount_amount por ítem).

ALTER TABLE public.proformas
  ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount  NUMERIC(14,2) NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
