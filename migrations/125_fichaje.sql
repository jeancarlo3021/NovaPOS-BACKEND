-- 125 — FICHAJE DE PLANILLA: marcar entrada y salida con código o biometría.
--
-- El fichaje ya existía en el servidor (`attendance_records` + clock-in/out)
-- pero no había por dónde usarlo: cero marcajes en toda la base. Y el endpoint
-- recibía el `employee_id` en el cuerpo, así que cualquiera con sesión podía
-- marcar por otro. Esto agrega la identificación del que marca.

-- Código personal de cuatro a ocho dígitos. Se guarda HASHEADO con salt:
-- un PIN en claro en la base es un PIN que cualquiera con acceso puede usar
-- para marcarle la entrada a otro.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS attendance_pin_hash text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS attendance_pin_set_at timestamptz;

-- Cómo se marcó, para poder auditar. 'pin' | 'biometria' | 'manual'
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS method text;
-- Desde qué aparato, y quién lo registró si fue a mano.
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS device text;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS marked_by uuid;

/*
 * HUELLA / FACEID (WebAuthn).
 *
 * No se guarda ninguna huella ni ninguna cara: eso nunca sale del teléfono.
 * Lo que se guarda es una LLAVE PÚBLICA que el aparato creó para este negocio,
 * y el teléfono solo la usa después de verificar al dueño con su biometría.
 * Si la base se filtra, no hay nada biométrico que filtrar.
 */
CREATE TABLE IF NOT EXISTS attendance_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  credential_id  text NOT NULL UNIQUE,
  public_key     text NOT NULL,
  counter        bigint NOT NULL DEFAULT 0,
  label          text,
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  last_used_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_att_cred_tenant   ON attendance_credentials(tenant_id);
CREATE INDEX IF NOT EXISTS idx_att_cred_employee ON attendance_credentials(employee_id);

COMMENT ON TABLE attendance_credentials IS
  'Llaves públicas WebAuthn para fichar con huella/FaceID. No contiene datos biométricos.';
