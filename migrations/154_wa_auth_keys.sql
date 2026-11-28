-- UNA FILA POR LLAVE DE WHATSAPP, EN VEZ DE UN BLOB DE 1 MB.
--
-- La sesión de Baileys se guardaba entera —credenciales MÁS todas las llaves de
-- señal— como un único JSON en wa_sessions.data. Ese blob solo crece (llegó a
-- 950 KB) y el worker lo reescribía COMPLETO cada vez que Baileys guardaba una
-- llave nueva: un megabyte a la base para persistir doscientos bytes.
--
-- Cada reescritura deja una versión nueva de la fila en el WAL. Con eso, una
-- base de 184 MB y 59 usuarios generaba ~50 MB de WAL entre checkpoints, la
-- decodificación lógica de Realtime tardaba 13 segundos en masticarlo, el disco
-- quedó saturado y en una instancia Micro (1 GB) la memoria comprometida se fue
-- a 1,21 GB. El login dejó de responder: 504/522 en /auth/v1/token.
--
-- Acá cada llave es su propia fila. Guardar una llave escribe una fila chica, y
-- las demás no se tocan.
CREATE TABLE IF NOT EXISTS wa_auth_keys (
  session_id  TEXT        NOT NULL,
  key_type    TEXT        NOT NULL,   -- 'pre-key', 'session', 'sender-key', 'app-state-sync-key'…
  key_id      TEXT        NOT NULL,
  value       TEXT        NOT NULL,   -- JSON del valor, serializado con BufferJSON
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, key_type, key_id)
);

-- Para borrar la sesión completa al desvincular.
CREATE INDEX IF NOT EXISTS wa_auth_keys_session_idx ON wa_auth_keys (session_id);

-- NADIE MÁS QUE EL WORKER.
--
-- Estas filas son las llaves de señal del WhatsApp del negocio: con ellas se
-- puede suplantar el número. El worker entra con service-role, que pasa por
-- encima de RLS, así que la tabla se deja con RLS activo y SIN NINGUNA política
-- —igual que wa_sessions—: nadie que use la llave pública o un token de usuario
-- ve una sola fila. Los permisos se quitan además a mano, porque una tabla nueva
-- hereda los GRANT del esquema public y no hay que confiar en eso para algo así.
ALTER TABLE wa_auth_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wa_auth_keys FROM anon, authenticated;

-- wa_sessions.data QUEDA, pero ahora guarda SOLO las credenciales (unos pocos KB).
-- El worker migra solo: si encuentra un blob con llaves adentro, las reparte en
-- wa_auth_keys y deja en data únicamente las credenciales. No hay que volver a
-- escanear el QR.
COMMENT ON COLUMN wa_sessions.data IS
  'Solo las credenciales (JSON con BufferJSON). Las llaves de señal van en wa_auth_keys, una por fila.';

-- ───────────────────────────────────────────────────────────────────────────────
-- REALTIME: se saca lo que nadie usa todavía.
--
-- La decodificación lógica lee TODO el WAL y recién después filtra por
-- publicación, así que estas dos tablas no eran la causa del problema. Pero
-- mientras no se usen, la replicación lógica no tiene por qué estar corriendo:
-- truck_positions tiene 7 filas (la última de hace un día) y mesa_llamadas está
-- vacía.
--
-- PARA VOLVER A PRENDERLAS cuando el rastreo de camiones o el llamado de mesa
-- entren en producción: Database → Replication en el panel de Supabase, o
--   ALTER PUBLICATION supabase_realtime ADD TABLE truck_positions;
-- (truck_positions ya tiene REPLICA IDENTITY FULL, de la migración 62; eso no se
--  toca acá, así que al re-agregarla sigue mandando todas las columnas).
-- ───────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime DROP TABLE truck_positions;
  EXCEPTION
    WHEN undefined_object THEN NULL;   -- no estaba en la publicación, o no existe la publicación
    WHEN undefined_table  THEN NULL;   -- no existe la tabla
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime DROP TABLE mesa_llamadas;
  EXCEPTION
    WHEN undefined_object THEN NULL;
    WHEN undefined_table  THEN NULL;
  END;
END $$;
