-- 140 · ANULAR UNA COMPRA YA RECIBIDA
--
-- Una orden PENDIENTE siempre se pudo cancelar: no movió nada. Una RECIBIDA no
-- tenía arreglo, y es justo la que se equivoca:
--
--   · se recibió la orden dos veces y el inventario quedó al doble;
--   · se cargó con las cantidades o los precios de otra factura;
--   · se recibió la orden del proveedor equivocado.
--
-- Hasta ahora eso se «arreglaba» a mano: ajustes de inventario uno por uno y
-- una cuenta por pagar fantasma que nadie se atrevía a borrar. Anular la compra
-- devuelve el stock con su ajuste anotado, cancela la cuenta por pagar y deja
-- la orden marcada, con quién la anuló y por qué.
--
-- El MOTIVO no es decorativo: una compra anulada sin explicación es una compra
-- que alguien va a volver a cargar la semana siguiente.

ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS cancelled_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by  UUID,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

COMMENT ON COLUMN public.purchases.cancelled_at IS
  'Cuándo se anuló la compra (NULL = no está anulada).';
COMMENT ON COLUMN public.purchases.cancelled_by IS
  'Usuario que la anuló.';
COMMENT ON COLUMN public.purchases.cancel_reason IS
  'Por qué se anuló: sin esto, alguien la vuelve a cargar la semana siguiente.';

NOTIFY pgrst, 'reload schema';
