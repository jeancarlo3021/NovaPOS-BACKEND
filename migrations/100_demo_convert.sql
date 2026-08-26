-- 100 · Qué pasa con la demo cuando termina.
--
-- Dos caminos y ninguno queda a la deriva:
--  · Le gustó  → se le asigna un plan, el negocio deja de ser demo y sigue con
--    todos sus datos (los que cargó en la prueba no se pierden).
--  · No compró → se borra sola. Antes las demos quedaban para siempre ocupando
--    la lista de negocios y nadie sabía cuáles ya no servían.

ALTER TABLE public.demo_requests
  ADD COLUMN IF NOT EXISTS converted_plan_id UUID,
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ,
  -- Día en que se borra el negocio de prueba si nadie la convirtió.
  ADD COLUMN IF NOT EXISTS purge_on DATE;

CREATE INDEX IF NOT EXISTS demo_requests_purge
  ON public.demo_requests (purge_on)
  WHERE purge_on IS NOT NULL AND converted_at IS NULL;

NOTIFY pgrst, 'reload schema';
