-- Precios especiales por cliente.
-- Permite definir un precio distinto al unit_price del producto para un cliente
-- específico. En el POS, al seleccionar el cliente se aplican estos precios.

CREATE TABLE IF NOT EXISTS customer_prices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  price       NUMERIC NOT NULL CHECK (price >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_prices_customer ON customer_prices(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_prices_tenant   ON customer_prices(tenant_id);
