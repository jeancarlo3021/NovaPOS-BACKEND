-- Recepción de comprobantes (Mensaje Receptor CRI). Guarda los comprobantes de
-- proveedores para poder enviarles la aceptación/rechazo ante Hacienda vía Alanube.
CREATE TABLE IF NOT EXISTS received_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  clave          TEXT NOT NULL,                 -- clave de 50 díg del comprobante del proveedor
  issuer_name    TEXT,
  issuer_id      TEXT,                          -- cédula del emisor (proveedor)
  document_type  TEXT,                          -- 01/02/03/04
  doc_date       TIMESTAMPTZ,
  total          NUMERIC DEFAULT 0,
  tax            NUMERIC DEFAULT 0,
  ack_status     TEXT DEFAULT 'pending',        -- pending | accepted | rejected
  ack_id         TEXT,                          -- id del Mensaje Receptor en Alanube
  raw            JSONB,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, clave)
);

CREATE INDEX IF NOT EXISTS idx_received_documents_tenant ON received_documents (tenant_id, doc_date DESC);
