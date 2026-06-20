-- ─── Módulo de Ruteo (reparto en camión) ───────────────────────────────────
-- El camión es una BODEGA secundaria (warehouses.type = 'truck'). La carga se
-- maneja con transfers (central → camión) y la devolución con transfers
-- (camión → central). Las rutas asignan clientes (paradas) a un camión/día.

-- Tipo de bodega y repartidor asignado.
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS type      TEXT NOT NULL DEFAULT 'central'; -- 'central' | 'truck'
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS driver_id UUID;

-- Rutas (una por camión y día).
CREATE TABLE IF NOT EXISTS routes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  warehouse_id  UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,  -- el camión
  driver_id     UUID,                                                        -- repartidor
  modality      TEXT NOT NULL DEFAULT 'autoventa',   -- 'autoventa' | 'preventa'
  route_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  status        TEXT NOT NULL DEFAULT 'open',         -- 'open' | 'closed'
  notes         TEXT,
  closed_at     TIMESTAMPTZ,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_routes_tenant ON routes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_routes_date   ON routes(tenant_id, route_date);

-- Paradas de la ruta (clientes a visitar, con orden y ubicación).
CREATE TABLE IF NOT EXISTS route_stops (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  route_id     UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  seq          INT  NOT NULL DEFAULT 0,               -- orden de visita
  lat          DOUBLE PRECISION,
  lng          DOUBLE PRECISION,
  status       TEXT NOT NULL DEFAULT 'pending',       -- 'pending' | 'visited' | 'no_sale'
  reason       TEXT,                                   -- motivo si no compró
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (route_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops(route_id);

-- Vincular ventas a la ruta (para el cierre/corte del día).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS route_id UUID;
CREATE INDEX IF NOT EXISTS idx_invoices_route ON invoices(route_id);
