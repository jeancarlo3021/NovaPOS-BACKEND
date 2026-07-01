-- Permite decimales en el stock de bodegas/camiones (ej. 1.5 kg al cargar).
-- Si la columna ya era numeric, el cambio es inocuo.

ALTER TABLE warehouse_stock  ALTER COLUMN quantity TYPE NUMERIC(14,3) USING quantity::numeric;

-- Por consistencia, el inventario del sistema también en decimales.
ALTER TABLE products ALTER COLUMN stock_quantity TYPE NUMERIC(14,3) USING stock_quantity::numeric;
