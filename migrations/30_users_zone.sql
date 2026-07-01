-- Zona asignada a un usuario (repartidor/vendedor): si está seteada, el usuario
-- solo ve los clientes / cuentas por cobrar / rutas de esa zona.

ALTER TABLE users ADD COLUMN IF NOT EXISTS zone TEXT;
