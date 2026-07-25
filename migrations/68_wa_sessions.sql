-- Credenciales de la sesión de WhatsApp (Baileys) del worker, guardadas en la BD
-- para que la sesión SOBREVIVA reinicios/redeploys sin depender de un volumen.
-- Una fila por sesión (hoy una sola: 'colonclick'). El worker usa service-role.
CREATE TABLE IF NOT EXISTS wa_sessions (
  id          TEXT PRIMARY KEY,
  data        TEXT,                                -- JSON (creds+keys) serializado con BufferJSON
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
