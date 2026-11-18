-- 142 · EL IVA CON QUE SE COBRÓ CADA LÍNEA
--
-- El comprobante electrónico sacaba la tasa de IVA del PRODUCTO. Para una línea
-- sin producto en el catálogo no había de dónde, y se declaraba al 0 %:
--
--   · el «Servicio 10%» del restaurante —que sí va en 0 y estaba bien por
--     casualidad—;
--   · un producto rápido escrito a mano en la caja, que se cobra con el IVA
--     que el cajero eligió y se declaraba exento.
--
-- En ese segundo caso el cliente paga el impuesto, Hacienda recibe una línea sin
-- impuesto, y el total del comprobante no coincide con el de la factura.
--
-- La tasa se guarda EN LA LÍNEA porque es con la que se cobró: el producto
-- puede cambiar de tasa mañana —cambia la ley, se corrige un error de carga— y
-- el comprobante de ayer tiene que seguir declarando lo que de verdad se cobró.

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS iva_rate NUMERIC;

COMMENT ON COLUMN public.invoice_items.iva_rate IS
  'Tasa de IVA (%) con la que se cobró esta línea. NULL = usar la del producto.';

NOTIFY pgrst, 'reload schema';
