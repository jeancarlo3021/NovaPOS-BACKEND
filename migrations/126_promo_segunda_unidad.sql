-- Promoción «la segunda a mitad de precio».
--
-- `type = 'second_half'` y `value` = el % que se le descuenta a la segunda
-- unidad (50 por defecto, pero puede ser 30 o 100).
--
-- `second_rule` decide A CUÁL de las dos se le hace el descuento cuando los
-- productos no valen lo mismo, que es casi siempre:
--   'barato' → al más barato del par (lo normal, lo que hace el supermercado)
--   'caro'   → al más caro (más generoso con el cliente)
-- Sin esta columna no habría forma de saber qué eligió el negocio, y los dos
-- casos dan totales distintos: con una camisa de ₡12.000 y otra de ₡8.000, el
-- cliente ahorra ₡4.000 o ₡6.000 según cuál se descuente.
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS second_rule TEXT;

COMMENT ON COLUMN promotions.second_rule IS
  'Promo de segunda unidad: a cuál del par se le aplica el descuento (barato|caro).';
