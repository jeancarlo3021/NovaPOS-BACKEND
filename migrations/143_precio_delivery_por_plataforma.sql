-- 143 · PRECIO DE DELIVERY POR PLATAFORMA
--
-- Había UN precio delivery por producto. Pero cada plataforma cobra una
-- comisión distinta —Uber no cobra lo mismo que Didi ni que PedidosYa—, así que
-- con un solo precio el negocio elige entre perder margen en la más cara o
-- cobrarle de más al cliente en la más barata. En la práctica terminan poniendo
-- el precio de la peor plataforma para todas.
--
-- `delivery_prices` guarda el precio por plataforma: {"Uber": 5500, "Didi": 5300}.
-- Las llaves son los nombres que usa el punto de venta (Uber, Didi, PedidosYa,
-- Otro). Lo que no esté puesto cae al `delivery_price` general, y si tampoco
-- hay, al precio normal: así un catálogo de mil productos no obliga a llenar
-- cuatro precios por producto para empezar a usarlo.
--
-- Va como JSONB y no como cuatro columnas porque las plataformas cambian —entra
-- una nueva, se va otra— y agregar una columna por cada una significaría una
-- migración y tocar el formulario cada vez.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS delivery_prices JSONB;

COMMENT ON COLUMN public.products.delivery_prices IS
  'Precio por plataforma de delivery: {"Uber": 5500, …}. Lo que falte cae a delivery_price.';

NOTIFY pgrst, 'reload schema';
