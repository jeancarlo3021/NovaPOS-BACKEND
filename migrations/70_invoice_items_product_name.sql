-- Bitácora/Reportes de productos: guardamos el NOMBRE del producto en cada línea
-- (snapshot) para que el reporte de productos vendidos funcione y sobreviva aunque
-- el producto se borre o se renombre. Además permitimos product_id NULL para los
-- productos rápidos/ad-hoc (no están en el catálogo).

ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS product_name TEXT;

-- Permitir líneas ad-hoc sin producto del catálogo.
ALTER TABLE invoice_items ALTER COLUMN product_id DROP NOT NULL;

-- Rellenar el nombre en las líneas existentes desde el catálogo (una sola vez).
UPDATE invoice_items ii
SET product_name = p.name
FROM products p
WHERE ii.product_name IS NULL
  AND ii.product_id = p.id;
