-- Alias por usuario para mostrar en el ticket ("Atendido por: …") — control interno.
-- No es fiscal; los datos del negocio (nombre, cédula) no cambian.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ticket_alias TEXT;
