-- Guarda el JSON ENVIADO a Hacienda/Alanube y la RESPUESTA, para poder verlos
-- en la bitácora FE y depurar errores rápido.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_request  JSONB;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_response JSONB;
