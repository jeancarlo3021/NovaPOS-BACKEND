-- Agentes de venta y sus PEDIDOS hacia caja.
--
-- Flujo: el agente arma el pedido con el cliente (en su propio dispositivo), lo
-- ENVÍA, y le aparece al cajero en su bandeja. El cajero lo carga en el POS y lo
-- cobra con el flujo normal (IVA, medios de pago, FE, impresión). Al cobrarse, el
-- pedido queda ligado a la factura y se le acredita la comisión al agente.

CREATE TABLE IF NOT EXISTS sales_agents (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  name               TEXT NOT NULL,
  -- Usuario del sistema, si el agente entra a la app. Puede ser NULL: hay agentes
  -- externos cuyos pedidos los carga otra persona.
  user_id            UUID,
  phone              TEXT,
  email              TEXT,
  identification     TEXT,
  /* Comisión sobre la venta cobrada (%). 0 = sin comisión. */
  commission_percent NUMERIC NOT NULL DEFAULT 0,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  agent_id      UUID REFERENCES sales_agents(id) ON DELETE SET NULL,
  agent_name    TEXT,                  -- snapshot: el pedido sobrevive al agente
  number        TEXT,                  -- consecutivo legible (P-000001)
  -- pending  = enviado, esperando en la bandeja del cajero
  -- taken    = un cajero lo tomó y lo está cobrando
  -- charged  = cobrado (ligado a invoice_id)
  -- cancelled= anulado por el agente o el cajero
  status        TEXT NOT NULL DEFAULT 'pending',
  customer_id   UUID,
  customer_name TEXT,
  customer_phone TEXT,
  notes         TEXT,
  total         NUMERIC NOT NULL DEFAULT 0,
  /* Comisión calculada al cobrar (monto, no %). */
  commission_amount NUMERIC,
  invoice_id    UUID,
  taken_by      UUID,                  -- cajero que lo tomó
  taken_at      TIMESTAMPTZ,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  charged_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_order_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID NOT NULL REFERENCES agent_orders(id) ON DELETE CASCADE,
  product_id   UUID,                   -- null en productos rápidos (ad-hoc)
  product_name TEXT NOT NULL,
  quantity     NUMERIC NOT NULL DEFAULT 1,
  unit_price   NUMERIC NOT NULL DEFAULT 0,
  subtotal     NUMERIC NOT NULL DEFAULT 0,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_agents_tenant   ON sales_agents (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS agent_orders_bandeja  ON agent_orders (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_orders_agent    ON agent_orders (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_order_items_ord ON agent_order_items (order_id);

-- Vendedor en la factura: sirve para el reporte de comisiones aunque el pedido se
-- borre. Resiliente: si la columna ya existe, no pasa nada.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sales_agent_id UUID;
