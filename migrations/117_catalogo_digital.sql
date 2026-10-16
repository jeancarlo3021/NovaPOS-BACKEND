-- CATÁLOGO DIGITAL: la misma página pública con QR, pero para productos.
--
-- El menú digital se hizo para restaurantes —platos, alérgenos, dietas— y la
-- migración 86 ya dejó dicho cómo crecer: «si algún día hacen falta varios, se
-- agrega una columna kind y se quita el PK sobre tenant_id». Es justo esto.
--
-- Un negocio que no vende comida necesita lo mismo con otro nombre y otro
-- contenido: una vitrina de su catálogo, con código de producto y
-- disponibilidad en vez de alérgenos. Es la misma mecánica (secciones, temas,
-- publicar, QR, visitas), así que comparte tabla y comparte código: duplicar
-- mil líneas para cambiar las etiquetas es garantizar que dentro de un año una
-- de las dos tenga los arreglos y la otra no.
--
-- `kind` = 'menu' | 'catalogo'. Un negocio puede tener los dos a la vez: un
-- restaurante con tienda de salsas, por ejemplo.

ALTER TABLE public.digital_menus
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'menu';

-- El PK pasa de (tenant_id) a (tenant_id, kind). Las filas que ya existen
-- quedan como 'menu' por el DEFAULT, así que ningún QR impreso deja de servir.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.digital_menus'::regclass
       AND contype = 'p'
       AND pg_get_constraintdef(oid) = 'PRIMARY KEY (tenant_id)'
  ) THEN
    ALTER TABLE public.digital_menus DROP CONSTRAINT digital_menus_pkey;
    ALTER TABLE public.digital_menus ADD PRIMARY KEY (tenant_id, kind);
  END IF;
END $$;

-- El slug sigue siendo único en toda la instalación: la página pública no tiene
-- sesión con la cual desambiguar, y /c/<slug> y /m/<slug> comparten espacio.

COMMENT ON COLUMN public.digital_menus.kind IS
  'menu = carta de restaurante · catalogo = vitrina de productos';

NOTIFY pgrst, 'reload schema';
