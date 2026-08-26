-- 97 · Seguimiento de clientes (quién está pidiendo y en qué va).
--
-- El cliente escribe por WhatsApp, el agente le pasa precio, queda de llamar el
-- jueves… y todo eso vive en la cabeza del agente. Cuando se va, se va la
-- cartera. Esto le pone historia a cada interesado: desde el primer contacto
-- hasta que se convierte en venta (o se pierde, y por qué).

CREATE TABLE IF NOT EXISTS public.leads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  number           TEXT,

  -- Cliente: puede ser uno del catálogo o alguien que todavía no existe como tal.
  customer_id      UUID,
  customer_name    TEXT NOT NULL,
  phone            TEXT,
  email            TEXT,
  zone             TEXT,

  -- Quién lo atiende.
  agent_id         UUID,
  agent_name       TEXT,

  -- De dónde salió: whatsapp | llamada | visita | referido | redes | mostrador | otro
  source           TEXT,
  -- Qué está pidiendo, en palabras del cliente.
  interest         TEXT,
  estimated_amount NUMERIC(14,2) NOT NULL DEFAULT 0,

  -- nuevo | contactado | cotizado | negociacion | ganado | perdido
  status           TEXT NOT NULL DEFAULT 'nuevo',
  lost_reason      TEXT,

  -- Cuándo se le habló por última vez y cuándo toca volver a hablarle.
  last_contact_at  TIMESTAMPTZ,
  next_follow_up   DATE,

  -- A dónde terminó: cotización, pedido de agente o venta.
  proforma_id      UUID,
  agent_order_id   UUID,
  invoice_id       UUID,
  closed_at        TIMESTAMPTZ,

  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cada toque con el cliente: llamada, WhatsApp, visita…
CREATE TABLE IF NOT EXISTS public.lead_interactions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  lead_id        UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  -- llamada | whatsapp | visita | correo | mensaje | cotizacion | otro
  kind           TEXT NOT NULL DEFAULT 'llamada',
  note           TEXT,
  -- Estado al que pasó el seguimiento con esta interacción (si cambió).
  status_after   TEXT,
  happened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_follow_up DATE,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_tenant_status
  ON public.leads (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS leads_follow_up
  ON public.leads (tenant_id, next_follow_up)
  WHERE status NOT IN ('ganado', 'perdido');
CREATE INDEX IF NOT EXISTS leads_agent
  ON public.leads (tenant_id, agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_interactions_lead
  ON public.lead_interactions (lead_id, happened_at DESC);

NOTIFY pgrst, 'reload schema';
