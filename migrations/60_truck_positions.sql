-- Posición ACTUAL de cada camión/repartidor (rastreo en tiempo real).
-- 1 fila por camión (UPSERT). No crece: el mapa vivo y Supabase Realtime leen de aquí.
-- Ver planeamiento: memory/truck_tracking_plan.md
CREATE TABLE IF NOT EXISTS truck_positions (
  tenant_id   UUID NOT NULL,
  truck_id    UUID NOT NULL,
  route_id    UUID,
  driver_id   UUID,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  speed       DOUBLE PRECISION,          -- km/h
  heading     DOUBLE PRECISION,          -- 0-360, para rotar el ícono
  accuracy    DOUBLE PRECISION,          -- metros
  battery     INT,                        -- % batería del teléfono
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, truck_id)
);

CREATE INDEX IF NOT EXISTS idx_truck_positions_route ON truck_positions(route_id);
CREATE INDEX IF NOT EXISTS idx_truck_positions_recorded ON truck_positions(tenant_id, recorded_at);
