-- La tabla suppliers ya se usaba con `tax_id` en el schema (Zod) pero la columna
-- nunca se creó en la base. Se agrega para poder guardar la cédula del proveedor
-- y de-duplicar en la recepción por correo (proveedor por cédula del emisor).
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tax_id TEXT;
