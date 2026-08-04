-- Promociones: permanentes y por cantidad.
--
-- 1) PERMANENTES. `ends_at` era NOT NULL, así que guardar una promo sin fecha de
--    fin reventaba con "null value in column ends_at violates not-null
--    constraint". Toda la aplicación ya trata `ends_at` nulo como "no vence"
--    (getPromoStatus, /promotions/active), así que lo que estaba mal era la
--    columna, no el código.
ALTER TABLE public.promotions
  ALTER COLUMN ends_at DROP NOT NULL;

-- 2) PROMO POR CANTIDAD ('qty_bundle'). "2 kg por ₡1000": se cobra el precio del
--    paquete por cada múltiplo completo y el sobrante va a precio normal.
--      1 kg → normal · 2 kg → ₡1000 · 3 kg → ₡1000 + 1 kg normal · 4 kg → ₡2000
--    `bundle_qty` es la cantidad del paquete y `value` su precio. Va en NUMERIC
--    con decimales porque hay productos que se venden por peso (0.5 kg, 1.5 kg).
ALTER TABLE public.promotions
  ADD COLUMN IF NOT EXISTS bundle_qty NUMERIC(12, 3);

COMMENT ON COLUMN public.promotions.bundle_qty IS
  'Promos por cantidad (type=qty_bundle): unidades/kg que forman el paquete. El precio del paquete es `value`.';

NOTIFY pgrst, 'reload schema';
