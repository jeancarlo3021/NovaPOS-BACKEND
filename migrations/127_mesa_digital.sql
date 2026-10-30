-- ═══════════════════════════════════════════════════════════════════════════
-- MESA DIGITAL — el QR de la mesa y los avisos del cliente al personal.
--
-- Es lo mismo que hace ColonTab, pero adentro de NovaPOS: el cliente escanea el
-- código de SU mesa, ve la carta que ya existe en el módulo de menú digital y
-- con un toque avisa que está listo para ordenar, llama al mesero o pide la
-- cuenta. El personal lo ve en vivo, con sonido.
--
-- Por qué el código es secreto y por mesa: si la dirección fuera
-- /mesa/7 cualquiera podría escribirla y mandar avisos de una mesa vacía desde
-- la calle. El token es aleatorio y la base lo vuelve a validar en cada aviso.
-- ═══════════════════════════════════════════════════════════════════════════

-- Un código aleatorio corto, fácil de poner en un QR.
CREATE OR REPLACE FUNCTION nuevo_token_mesa() RETURNS TEXT
LANGUAGE sql VOLATILE AS $$
  SELECT translate(encode(gen_random_bytes(9), 'base64'), '+/=', 'xyz')
$$;

CREATE TABLE IF NOT EXISTS mesa_tokens (
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  numero     INT  NOT NULL CHECK (numero > 0),
  token      TEXT NOT NULL UNIQUE DEFAULT nuevo_token_mesa(),
  nombre     TEXT,                        -- «Terraza 3», si la mesa tiene nombre
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, numero)
);

-- Los avisos del cliente: listo para ordenar / mesero / cuenta.
CREATE TABLE IF NOT EXISTS mesa_llamadas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  numero         INT  NOT NULL CHECK (numero > 0),
  tipo           TEXT NOT NULL CHECK (tipo IN ('ordenar','mesero','cuenta')),
  personas       INT  CHECK (personas BETWEEN 1 AND 100),
  medio_pago     TEXT CHECK (medio_pago IN ('efectivo','tarjeta','sinpe')),
  estado         TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','atendida')),
  atendida_at    TIMESTAMPTZ,
  atendida_por   UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- El panel pregunta siempre por lo PENDIENTE de un negocio, ordenado por hora.
CREATE INDEX IF NOT EXISTS mesa_llamadas_pendientes
  ON mesa_llamadas (tenant_id, estado, created_at);

CREATE TABLE IF NOT EXISTS mesa_sugerencias (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  numero     INT,
  estrellas  INT CHECK (estrellas BETWEEN 1 AND 5),
  mensaje    TEXT NOT NULL CHECK (char_length(mensaje) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mesa_sugerencias_tenant
  ON mesa_sugerencias (tenant_id, created_at DESC);

-- Cada vez que alguien abre la página de una mesa. Sirve para saber si los QR
-- se están usando y cuáles mesas no los usan nunca.
CREATE TABLE IF NOT EXISTS mesa_visitas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  numero     INT  NOT NULL CHECK (numero > 0),
  origen     TEXT NOT NULL DEFAULT 'qr' CHECK (origen IN ('qr','nfc','enlace')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mesa_visitas_tenant
  ON mesa_visitas (tenant_id, created_at DESC);

-- El tiempo real del panel necesita que la tabla publique sus cambios.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE mesa_llamadas;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;

COMMENT ON TABLE mesa_tokens IS 'Código secreto de cada mesa: va en el QR o la etiqueta NFC.';
COMMENT ON TABLE mesa_llamadas IS 'Avisos del cliente desde la mesa (ordenar/mesero/cuenta).';
