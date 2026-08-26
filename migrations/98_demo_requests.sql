-- 98 · Solicitudes de demo.
--
-- El vendedor visita un negocio, ve qué necesita y pide una demo con ESOS
-- módulos. Antes eso se pedía por WhatsApp: se perdía, llegaba incompleto o el
-- que la armaba no sabía qué le habían prometido al cliente.

CREATE TABLE IF NOT EXISTS public.demo_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant del VENDEDOR que la solicita (quién pide), no el del prospecto.
  tenant_id      UUID NOT NULL,
  number         TEXT,

  -- Prospecto
  business_name  TEXT NOT NULL,
  contact_name   TEXT,
  phone          TEXT,
  email          TEXT,
  business_type  TEXT,              -- abarrotes, restaurante, taller, veterinaria…
  notes          TEXT,

  -- Qué se le quiere mostrar: ['pos','inventory','restaurant',...]
  modules        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Días de prueba solicitados.
  days           INTEGER NOT NULL DEFAULT 15,

  -- pendiente | aprobada | rechazada | entregada | vencida
  status         TEXT NOT NULL DEFAULT 'pendiente',
  reject_reason  TEXT,

  -- Vendedor que la pidió (usuario del sistema).
  requested_by   UUID,
  requester_name TEXT,

  -- Cuando se arma la demo: a qué negocio quedó ligada y hasta cuándo.
  demo_tenant_id UUID,
  demo_user      TEXT,              -- usuario de acceso entregado al prospecto
  expires_on     DATE,
  delivered_at   TIMESTAMPTZ,
  reviewed_by    UUID,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS demo_requests_tenant_status
  ON public.demo_requests (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS demo_requests_requester
  ON public.demo_requests (tenant_id, requested_by);

NOTIFY pgrst, 'reload schema';
