-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 04: Storage Buckets (logos, productos) + columna image_url en products
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Ejecutar en Supabase SQL Editor
-- https://supabase.com/dashboard/project/hdmxpjscmkgfettmqcyl/sql/new

-- ── 1. CREAR BUCKETS ────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('logos', 'logos', true, 524288,
   ARRAY['image/jpeg','image/png','image/webp','image/svg+xml']),

  ('products', 'products', true, 1048576,
   ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── 2. AGREGAR COLUMNA image_url A PRODUCTS ─────────────────────────────────

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT NULL;

COMMENT ON COLUMN public.products.image_url IS
  'URL pública de la imagen del producto en Supabase Storage (bucket: products)';

-- ── 3. POLÍTICAS RLS PARA LOGOS ─────────────────────────────────────────────

-- Limpiar políticas viejas si existen
DROP POLICY IF EXISTS "logos_public_read"   ON storage.objects;
DROP POLICY IF EXISTS "logos_tenant_insert" ON storage.objects;
DROP POLICY IF EXISTS "logos_tenant_update" ON storage.objects;
DROP POLICY IF EXISTS "logos_tenant_delete" ON storage.objects;

-- Lectura pública (cualquiera puede ver logos)
CREATE POLICY "logos_public_read"
ON storage.objects FOR SELECT
USING (bucket_id = 'logos');

-- Solo usuarios autenticados de un tenant pueden subir a su carpeta
CREATE POLICY "logos_tenant_insert"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'logos'
  AND (storage.foldername(name))[1] IN (
    SELECT tenant_id::text FROM public.users WHERE id = auth.uid()
  )
);

CREATE POLICY "logos_tenant_update"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'logos'
  AND (storage.foldername(name))[1] IN (
    SELECT tenant_id::text FROM public.users WHERE id = auth.uid()
  )
);

CREATE POLICY "logos_tenant_delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'logos'
  AND (storage.foldername(name))[1] IN (
    SELECT tenant_id::text FROM public.users WHERE id = auth.uid()
  )
);

-- ── 4. POLÍTICAS RLS PARA PRODUCTOS ─────────────────────────────────────────

DROP POLICY IF EXISTS "products_public_read"   ON storage.objects;
DROP POLICY IF EXISTS "products_tenant_insert" ON storage.objects;
DROP POLICY IF EXISTS "products_tenant_update" ON storage.objects;
DROP POLICY IF EXISTS "products_tenant_delete" ON storage.objects;

CREATE POLICY "products_public_read"
ON storage.objects FOR SELECT
USING (bucket_id = 'products');

CREATE POLICY "products_tenant_insert"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'products'
  AND (storage.foldername(name))[1] IN (
    SELECT tenant_id::text FROM public.users WHERE id = auth.uid()
  )
);

CREATE POLICY "products_tenant_update"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'products'
  AND (storage.foldername(name))[1] IN (
    SELECT tenant_id::text FROM public.users WHERE id = auth.uid()
  )
);

CREATE POLICY "products_tenant_delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'products'
  AND (storage.foldername(name))[1] IN (
    SELECT tenant_id::text FROM public.users WHERE id = auth.uid()
  )
);

-- ── 5. REFRESH SCHEMA CACHE ────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ── 6. VERIFICACIÓN ─────────────────────────────────────────────────────────
SELECT id, name, public, file_size_limit FROM storage.buckets
WHERE id IN ('logos', 'products');

SELECT policyname FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
  AND policyname LIKE '%logos%' OR policyname LIKE '%products%';
