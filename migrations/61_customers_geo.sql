-- Ubicación geográfica del cliente (para el rastreo/mapa de reparto).
-- Se fija con el selector de mapa en la ficha del cliente; al crear una ruta
-- se copia a route_stops.lat/lng. Ver memory/truck_tracking_plan.md
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
