-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 11: Reparar check constraint de tenants.status
-- ═══════════════════════════════════════════════════════════════════════════
-- Síntoma: al crear un negocio (admin-create-owner edge function) Postgres
-- responde con "new row for relation 'tenants' violates check constraint
-- 'tenants_status_check'". La función inserta status='active' pero el
-- constraint en producción no contempla los valores que la app usa.
--
-- Esta migración elimina el constraint existente y lo recrea con los valores
-- que el código realmente envía: 'active', 'suspended', 'inactive',
-- 'cancelled', 'trial'.

ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_status_check;

-- Si hay filas con valores fuera de la lista, las normalizamos primero para
-- que el nuevo CHECK no falle al añadirlo.
UPDATE public.tenants
SET status = 'active'
WHERE status IS NULL
   OR status NOT IN ('active', 'suspended', 'inactive', 'cancelled', 'trial');

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('active', 'suspended', 'inactive', 'cancelled', 'trial'));

-- Asegura un default razonable para futuras inserciones sin status.
ALTER TABLE public.tenants
  ALTER COLUMN status SET DEFAULT 'active';

NOTIFY pgrst, 'reload schema';
