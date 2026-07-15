-- Recepción de comprobantes por CORREO (reemplaza el flujo Alanube que no servía).
-- Un buzón central recibe los XML de Hacienda; un cron los lee cada 15 min, los
-- registra en la bandeja y crea un borrador de compra.
ALTER TABLE received_documents ADD COLUMN IF NOT EXISTS source      TEXT DEFAULT 'manual';  -- email | manual | alanube
ALTER TABLE received_documents ADD COLUMN IF NOT EXISTS email_from  TEXT;                   -- remitente del correo
ALTER TABLE received_documents ADD COLUMN IF NOT EXISTS receiver_id TEXT;                   -- cédula del receptor (nuestra empresa)
ALTER TABLE received_documents ADD COLUMN IF NOT EXISTS xml         TEXT;                    -- XML crudo del comprobante
ALTER TABLE received_documents ADD COLUMN IF NOT EXISTS purchase_id UUID;                    -- borrador de compra creado
