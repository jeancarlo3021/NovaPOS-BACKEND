-- Agenda de pedidos y enlace con proformas.
--
-- ── Agenda ────────────────────────────────────────────────────────────────
-- Un agente de ruta no vende para hoy: acuerda con el cliente que la entrega o
-- el cobro es el jueves. Sin una fecha, todos los pedidos caían juntos en la
-- bandeja de caja y el cajero no podía distinguir lo de hoy de lo de la otra
-- semana — así que o se cobraba antes de tiempo, o se traspapelaba.
ALTER TABLE public.agent_orders
  ADD COLUMN IF NOT EXISTS scheduled_date DATE,
  ADD COLUMN IF NOT EXISTS scheduled_note TEXT;

-- Los pedidos que ya existen se agendan para el día en que se crearon: es la
-- única fecha real que hay, y dejarlos sin fecha los sacaría de la agenda.
UPDATE public.agent_orders
   SET scheduled_date = (created_at AT TIME ZONE 'America/Costa_Rica')::date
 WHERE scheduled_date IS NULL;

CREATE INDEX IF NOT EXISTS agent_orders_agenda
  ON public.agent_orders (tenant_id, scheduled_date, status);

-- ── Proformas ─────────────────────────────────────────────────────────────
-- El agente cotiza y después el cliente confirma. Sin este vínculo había que
-- volver a digitar el pedido entero, y la proforma quedaba abierta para siempre
-- aunque la venta ya se hubiera hecho.
ALTER TABLE public.agent_orders
  ADD COLUMN IF NOT EXISTS proforma_id UUID;

CREATE INDEX IF NOT EXISTS agent_orders_proforma
  ON public.agent_orders (proforma_id) WHERE proforma_id IS NOT NULL;

-- Camino inverso: desde la proforma se ve si ya se convirtió en pedido.
ALTER TABLE public.proformas
  ADD COLUMN IF NOT EXISTS agent_order_id UUID;

NOTIFY pgrst, 'reload schema';
