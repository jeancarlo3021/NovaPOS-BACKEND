-- 96 · "No se pudo": entregas y tareas que hay que reprogramar.
--
-- El repartidor llega y el cliente no está, o falta el producto. Antes eso se
-- resolvía por WhatsApp y el pedido quedaba en la agenda de ayer para siempre.
-- Ahora se marca desde la calle con el motivo, y la agenda avisa que hay algo
-- esperando fecha nueva.

ALTER TABLE public.agent_orders
  ADD COLUMN IF NOT EXISTS needs_reschedule BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reject_reason TEXT,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

ALTER TABLE public.agenda_tasks
  ADD COLUMN IF NOT EXISTS needs_reschedule BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reject_reason TEXT,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS agent_orders_needs_reschedule
  ON public.agent_orders (tenant_id, scheduled_date) WHERE needs_reschedule = true;
CREATE INDEX IF NOT EXISTS agenda_tasks_needs_reschedule
  ON public.agenda_tasks (tenant_id, scheduled_date) WHERE needs_reschedule = true;

NOTIFY pgrst, 'reload schema';
