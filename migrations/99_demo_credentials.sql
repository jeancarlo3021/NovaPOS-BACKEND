-- 99 · Credenciales de la demo, listas desde que se pide.
--
-- El vendedor está EN EL NEGOCIO cuando pide la prueba: si el usuario y la clave
-- llegan después por WhatsApp, se pierde el momento. Se generan al crear la
-- solicitud, a partir del nombre del negocio, para poder dictarlas ahí mismo.

ALTER TABLE public.demo_requests
  ADD COLUMN IF NOT EXISTS demo_password TEXT;

-- El usuario de la demo no se puede repetir dentro del mismo negocio vendedor.
CREATE UNIQUE INDEX IF NOT EXISTS demo_requests_user_unique
  ON public.demo_requests (tenant_id, demo_user) WHERE demo_user IS NOT NULL;

NOTIFY pgrst, 'reload schema';
