-- 92 · Lugar de entrega en la agenda.
-- La agenda sin lugar no sirve para armar ruta: hay que saber A DÓNDE va cada
-- entrega. Se guarda como snapshot (igual que customer_name) porque el cliente
-- puede cambiar de dirección después y la entrega ya fue a la vieja.

ALTER TABLE public.agent_orders
  ADD COLUMN IF NOT EXISTS customer_zone TEXT,
  ADD COLUMN IF NOT EXISTS delivery_place TEXT;

CREATE INDEX IF NOT EXISTS agent_orders_zone
  ON public.agent_orders (tenant_id, scheduled_date, customer_zone)
  WHERE customer_zone IS NOT NULL;

NOTIFY pgrst, 'reload schema';
