-- Devoluciones.
--
-- Anular una factura completa YA existía (invoices.status='cancelled', que repone
-- el stock). Lo que faltaba es la devolución PARCIAL: el cliente trae 2 de 5
-- unidades. Eso no es una anulación —la venta sigue existiendo por el resto— así
-- que necesita su propio registro.

-- ── Devoluciones de CLIENTE (sobre una venta) ───────────────────────────────
CREATE TABLE IF NOT EXISTS sales_returns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  invoice_id    UUID,                    -- venta original (puede faltar: devolución suelta)
  invoice_number TEXT,
  number        TEXT,                    -- consecutivo legible (D-000001)
  customer_id   UUID,
  customer_name TEXT,
  reason        TEXT,
  /* refund = se devolvió el dinero · credit = queda a favor · exchange = cambio */
  resolution    TEXT NOT NULL DEFAULT 'refund',
  total         NUMERIC NOT NULL DEFAULT 0,
  /* ¿Se repuso el stock? Un producto dañado se devuelve pero NO vuelve a la venta. */
  restock       BOOLEAN NOT NULL DEFAULT true,
  /* Nota de crédito emitida (si la venta era electrónica). */
  fe_nc_clave   TEXT,
  cash_session_id UUID,                  -- caja donde se pagó la devolución
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales_return_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id    UUID NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  product_id   UUID,
  product_name TEXT NOT NULL,
  quantity     NUMERIC NOT NULL DEFAULT 1,
  unit_price   NUMERIC NOT NULL DEFAULT 0,
  subtotal     NUMERIC NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Devoluciones a PROVEEDOR (sobre una compra) ─────────────────────────────
CREATE TABLE IF NOT EXISTS supplier_returns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  purchase_id   UUID,                    -- compra original (opcional)
  purchase_number TEXT,
  number        TEXT,                    -- consecutivo legible (DP-000001)
  supplier_id   UUID,
  supplier_name TEXT,
  reason        TEXT,
  /* credit_note = el proveedor da nota de crédito · refund = devuelve el dinero
     · replacement = repone la mercadería */
  resolution    TEXT NOT NULL DEFAULT 'credit_note',
  total         NUMERIC NOT NULL DEFAULT 0,
  /* pending = enviada al proveedor · settled = ya la reconoció */
  status        TEXT NOT NULL DEFAULT 'pending',
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS supplier_return_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id    UUID NOT NULL REFERENCES supplier_returns(id) ON DELETE CASCADE,
  product_id   UUID,
  product_name TEXT NOT NULL,
  quantity     NUMERIC NOT NULL DEFAULT 1,
  unit_cost    NUMERIC NOT NULL DEFAULT 0,
  subtotal     NUMERIC NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_returns_tenant     ON sales_returns (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sales_returns_invoice    ON sales_returns (invoice_id);
CREATE INDEX IF NOT EXISTS sales_return_items_ret   ON sales_return_items (return_id);
CREATE INDEX IF NOT EXISTS supplier_returns_tenant  ON supplier_returns (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS supplier_return_items_r  ON supplier_return_items (return_id);
