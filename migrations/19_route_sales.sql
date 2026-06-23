-- Ventas y pedidos de ruta (Distribución).
-- Las ventas de ruta (autoventa) son facturas SIN caja chica → cash_session_id null.
ALTER TABLE invoices ALTER COLUMN cash_session_id DROP NOT NULL;

-- Pedidos de preventa (lo que hay que entregar después en el local).
CREATE TABLE IF NOT EXISTS route_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  route_id      UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  customer_id   UUID REFERENCES customers(id),
  customer_name TEXT,
  total         NUMERIC NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'delivered' | 'cancelled'
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_route_orders_route ON route_orders(route_id);

CREATE TABLE IF NOT EXISTS route_order_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES route_orders(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL,
  quantity    NUMERIC NOT NULL,
  unit_price  NUMERIC NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_route_order_items_order ON route_order_items(order_id);
