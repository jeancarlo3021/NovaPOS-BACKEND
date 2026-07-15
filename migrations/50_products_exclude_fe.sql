-- Productos que NO se envían a Hacienda (facturación electrónica). Útil para
-- artículos sin precio (regalías, muestras, notas internas) que no deben ir en el
-- comprobante electrónico.
ALTER TABLE products ADD COLUMN IF NOT EXISTS exclude_from_fe BOOLEAN DEFAULT false;
