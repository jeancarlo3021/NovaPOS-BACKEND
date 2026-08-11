-- Mover una cuenta de mesa y cambiar el mesero responsable.
--
-- `opened_by` guarda quién ABRIÓ la cuenta y no debe cambiar: es el registro de
-- lo que pasó. Pero el responsable sí cambia —el turno de la tarde recibe las
-- mesas del de la mañana—, así que hace falta una columna aparte. Sobrescribir
-- `opened_by` habría borrado quién tomó la mesa originalmente.
ALTER TABLE public.table_orders
  ADD COLUMN IF NOT EXISTS waiter_id UUID;

-- Rastro del último traslado. Mover una cuenta sin dejar huella es justo el
-- movimiento que sirve para esconder consumo, así que queda de dónde vino y
-- cuándo. Solo el último: un historial completo no lo pidió nadie y esto ya
-- responde la pregunta que se hace en el salón («¿esta cuenta no estaba en la 3?»).
ALTER TABLE public.table_orders
  ADD COLUMN IF NOT EXISTS moved_from_label TEXT,
  ADD COLUMN IF NOT EXISTS moved_at         TIMESTAMPTZ;

-- Las cuentas ya abiertas siguen a nombre de quien las abrió.
UPDATE public.table_orders SET waiter_id = opened_by
 WHERE waiter_id IS NULL AND opened_by IS NOT NULL;

NOTIFY pgrst, 'reload schema';
