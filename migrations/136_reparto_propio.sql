-- 136 · REPARTO PROPIO (el repartidor del negocio)
--
-- El sistema ya tenía «delivery», pero era el de PLATAFORMAS: Uber, PedidosYa
-- y compañía, que cobran un porcentaje y pagan después. Esas ventas se miran
-- aparte justamente porque la plata NO entra a la caja del día.
--
-- El reparto propio es lo contrario: el muchacho sale en moto, cobra el
-- domicilio y vuelve con la plata. Entra a la caja como cualquier venta, y lo
-- que hacía falta era poder separarlo del precio de la comida para saber
-- cuánto se movió en repartos.
--
-- ── Dónde vive el monto ───────────────────────────────────────────────────
-- EN LA FACTURA, como una línea más («Entrega a domicilio»), con su CAByS.
-- Así funciona con factura electrónica sin inventar nada, y el cliente ve en
-- su tiquete lo que de verdad está pagando. El reporte se arma de esas
-- líneas: una sola fuente de verdad, sin un total paralelo que pueda
-- contradecirla.
--
-- Acá solo se agrega lo que la línea NO puede decir: quién lo llevó y a qué
-- zona. Sin eso, un reporte de reparto solo puede contar plata, y la pregunta
-- del dueño es «¿cuántos viajes hizo cada uno y para dónde?».

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS delivery_person TEXT,
  ADD COLUMN IF NOT EXISTS delivery_zone   TEXT;

COMMENT ON COLUMN public.invoices.delivery_person IS
  'Quién hizo el reparto (reparto propio, no plataformas).';
COMMENT ON COLUMN public.invoices.delivery_zone IS
  'Zona o tarifa aplicada al reparto: es lo que explica por qué el cobro fue ese.';

-- Para el reporte: las ventas con reparto de un período, por persona.
CREATE INDEX IF NOT EXISTS invoices_reparto
  ON public.invoices (tenant_id, delivery_person, issued_at)
  WHERE delivery_person IS NOT NULL;

NOTIFY pgrst, 'reload schema';
