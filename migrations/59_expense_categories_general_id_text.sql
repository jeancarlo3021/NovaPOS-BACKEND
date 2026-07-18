-- `general_category_id` referencia el catálogo de categorías generales, pero ese
-- catálogo vive EN CÓDIGO (DEFAULT_CATEGORIES, ids '1'..'12'), no en una tabla.
-- La columna tenía un FK a una tabla UUID que el código NO usa → al guardar '7'
-- fallaba con "invalid input syntax for type uuid: 7".
-- Se quita el FK y se convierte la columna a TEXT para que acepte '1'..'12'.
ALTER TABLE expense_categories
  DROP CONSTRAINT IF EXISTS expense_categories_general_category_id_fkey;

ALTER TABLE expense_categories
  ALTER COLUMN general_category_id TYPE TEXT USING general_category_id::text;
