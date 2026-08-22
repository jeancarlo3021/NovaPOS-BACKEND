-- 94 · Tareas de agenda (mandados, trámites, visitas).
--
-- No todo lo que hay que hacer en el día es una entrega con factura: "ir a la
-- encomienda", "pasar al banco", "recoger repuesto donde el proveedor". Estas
-- tareas comparten el día con las entregas y necesitan lo mismo: responsable,
-- hora, lugar, y poder pasarlas a otro día cuando no se llegó.

CREATE TABLE IF NOT EXISTS public.agenda_tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  title          TEXT NOT NULL,
  notes          TEXT,
  scheduled_date DATE NOT NULL,
  scheduled_time TIME,
  -- Lugares a los que hay que ir: [{name, address, lat, lng, done}]
  places         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Fotos de respaldo (comprobante de encomienda, factura del proveedor…)
  photos         JSONB NOT NULL DEFAULT '[]'::jsonb,
  assigned_to    UUID,
  assigned_name  TEXT,
  -- pending | done | cancelled
  status         TEXT NOT NULL DEFAULT 'pending',
  done_at        TIMESTAMPTZ,
  done_by        UUID,
  -- Bitácora de traslados: [{from, to, at, by, reason}]
  reschedule_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agenda_tasks_day
  ON public.agenda_tasks (tenant_id, scheduled_date, status);
CREATE INDEX IF NOT EXISTS agenda_tasks_assigned
  ON public.agenda_tasks (tenant_id, assigned_to, scheduled_date)
  WHERE assigned_to IS NOT NULL;

NOTIFY pgrst, 'reload schema';
