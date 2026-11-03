-- 134 · ENTREGAS PENDIENTES — el calendario de lo que hay prometido
--
-- Lo que faltaba: la pregunta «¿qué tengo que entregar esta semana y quién me
-- debe?». Hasta ahora el taller tenía las VENTAS (lo que ya se cobró) y la
-- COLA DE IMPRESIÓN (lo que está en la máquina), pero no el compromiso: el
-- cliente que encargó tres piezas para el viernes y dejó la mitad adelantada.
--
-- Por qué no alcanzaba con lo que había:
--  · Una venta es plata que YA entró. Un encargo a medio pagar no es una venta
--    del día: meterlo ahí infla lo vendido con plata que todavía no está.
--  · La cola de impresión habla de MÁQUINAS. Hay entregas que no se imprimen
--    (un diseño, una reparación) y piezas que se imprimen sin estar prometidas.
--
-- El pago se guarda como UN MONTO adelantado, no como una casilla de
-- «adelantó sí/no»: la pregunta real es cuánto falta. «Pago completo» es el
-- caso en que ese monto es igual al total, y `estado_pago` se calcula de los
-- montos —nunca se escribe a mano— para que no pueda decir «pagado» con saldo
-- pendiente.
--
-- Entregar NO crea una venta automáticamente: el taller cobra por SINPE antes,
-- durante o después, y adivinar la fecha del cobro ensuciaría el corte del día.
-- Lo que queda por cobrar se ve acá, en el saldo.

CREATE TABLE IF NOT EXISTS public.taller_entregas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  -- El día en que se prometió. Es la columna del calendario.
  fecha_entrega DATE NOT NULL,
  cliente       TEXT NOT NULL,
  customer_id   UUID,
  telefono      TEXT,
  -- La suma de las líneas. La calcula el servidor.
  total         NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Cuánto dejó pagado. 0 = no adelantó nada; = total = pagó completo.
  adelanto      NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- sin_pago | adelanto | pagado — DERIVADO de total y adelanto.
  estado_pago   TEXT NOT NULL DEFAULT 'sin_pago',
  -- Con qué pagó el adelanto (efectivo, sinpe…). Null si no ha pagado nada.
  medio_pago    TEXT,
  -- pendiente | entregado | cancelado
  estado        TEXT NOT NULL DEFAULT 'pendiente',
  entregado_at      TIMESTAMPTZ,
  entregado_por     UUID,
  entregado_nombre  TEXT,
  notas         TEXT,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS taller_entregas_dia
  ON public.taller_entregas (tenant_id, estado, fecha_entrega);

-- Los artículos de la entrega, igual que en la venta: el nombre y el precio
-- van como TEXTO, para que el encargo siga diciendo qué se prometió y a cuánto
-- aunque mañana cambie el catálogo.
CREATE TABLE IF NOT EXISTS public.taller_entrega_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  entrega_id  UUID NOT NULL REFERENCES public.taller_entregas(id) ON DELETE CASCADE,
  producto_id UUID REFERENCES public.taller_catalogo(id) ON DELETE SET NULL,
  descripcion TEXT NOT NULL,
  variante    TEXT,
  cantidad    NUMERIC(12,2) NOT NULL DEFAULT 1,
  precio_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
  subtotal    NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS taller_entrega_items_entrega
  ON public.taller_entrega_items (entrega_id);

COMMENT ON COLUMN public.taller_entregas.estado_pago IS
  'Derivado: sin_pago (adelanto 0) · adelanto (0 < adelanto < total) · pagado (adelanto = total)';
COMMENT ON COLUMN public.taller_entregas.adelanto IS
  'Lo que el cliente ya dejó pagado. El saldo es total - adelanto.';

NOTIFY pgrst, 'reload schema';
