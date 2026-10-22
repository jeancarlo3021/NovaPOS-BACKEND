-- 124 — Cambios de componentes de un KIT hechos al vender.
--
-- Un combo puede venderse con un componente cambiado: la galleta de chocolate
-- se agotó y el cliente acepta la de vainilla. La receta del kit NO cambia
-- —mañana vuelve a haber chocolate—, pero el inventario tiene que bajar lo que
-- de verdad salió, y una anulación tiene que devolver eso mismo.
--
-- Cada elemento: { "from": uuid, "to": uuid, "from_name": texto, "to_name": texto }
-- Los nombres van guardados a propósito: si el producto se borra, el tiquete
-- viejo tiene que poder seguir diciendo qué se entregó.
ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS kit_substitutions jsonb;

COMMENT ON COLUMN invoice_items.kit_substitutions IS
  'Cambios de componentes del kit hechos en esta venta (no alteran la receta del kit).';
