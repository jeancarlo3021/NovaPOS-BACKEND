-- Cuentas abiertas por MESA (restaurante).
--
-- El mapa de mesas vivía en `settings/tables-map` como plano decorativo: no había
-- forma de abrir una cuenta en una mesa, ir sumándole consumos y cobrarla al final.
-- Esta tabla es esa cuenta: se abre al sentar a los clientes, acumula líneas en
-- varias tandas y se cierra al cobrar (quedando ligada a la factura resultante).
CREATE TABLE IF NOT EXISTS table_orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  -- Id del elemento del mapa (settings/tables-map). No hay FK: el mapa es un JSON.
  table_id     TEXT NOT NULL,
  table_label  TEXT,                    -- nombre visible ("Mesa 4"), snapshot
  status       TEXT NOT NULL DEFAULT 'open',   -- open | closed | cancelled
  guests       INT  DEFAULT 1,
  notes        TEXT,
  opened_by    UUID,                    -- usuario que abrió (mesero)
  opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ,
  -- Factura con la que se cobró (null mientras la cuenta está abierta).
  invoice_id   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Líneas de consumo. Se agregan en TANDAS: cada ronda queda con su hora, para que
-- la cocina y el mesero sepan qué se pidió cuándo.
CREATE TABLE IF NOT EXISTS table_order_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL REFERENCES table_orders(id) ON DELETE CASCADE,
  product_id     UUID,                  -- null en productos rápidos (ad-hoc)
  product_name   TEXT NOT NULL,
  quantity       NUMERIC NOT NULL DEFAULT 1,
  unit_price     NUMERIC NOT NULL DEFAULT 0,
  discount_percent NUMERIC DEFAULT 0,
  subtotal       NUMERIC NOT NULL DEFAULT 0,
  -- Nota de cocina de la línea ("sin cebolla", "término medio").
  notes          TEXT,
  -- Ronda/tanda en que se pidió (1, 2, 3…). Sirve para reimprimir solo lo nuevo.
  course         INT NOT NULL DEFAULT 1,
  /* ¿Ya se mandó a la comanda de cocina? Evita reimprimir lo de la ronda anterior. */
  sent_to_kitchen BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Una mesa NO puede tener dos cuentas abiertas a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS table_orders_one_open
  ON table_orders (tenant_id, table_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS table_orders_tenant_status ON table_orders (tenant_id, status);
CREATE INDEX IF NOT EXISTS table_order_items_order    ON table_order_items (order_id);
