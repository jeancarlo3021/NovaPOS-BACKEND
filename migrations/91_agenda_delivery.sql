-- 91 · Agenda de entregas: responsable y hora del pedido.
-- El día ya vive en agent_orders.scheduled_date (migración 90). Acá se agrega
-- QUIÉN entrega y A QUÉ HORA, que es lo que hace falta para repartir la ruta.

ALTER TABLE public.agent_orders
  ADD COLUMN IF NOT EXISTS scheduled_time TIME,
  -- Snapshot del nombre: el pedido tiene que seguir legible aunque después se
  -- desactive el usuario o le cambien el nombre.
  ADD COLUMN IF NOT EXISTS assigned_to UUID,
  ADD COLUMN IF NOT EXISTS assigned_name TEXT,
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
  -- Bitácora de reprogramaciones: [{from, to, at, by, reason}]
  ADD COLUMN IF NOT EXISTS reschedule_log JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS agent_orders_assigned
  ON public.agent_orders (tenant_id, assigned_to, scheduled_date)
  WHERE assigned_to IS NOT NULL;

NOTIFY pgrst, 'reload schema';
