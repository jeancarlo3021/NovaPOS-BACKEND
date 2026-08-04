-- El módulo de Restaurante (/billing) guardaba las cuentas en el localStorage del
-- navegador: no se compartían entre dispositivos —el mesero con tablet y el cajero
-- veían cosas distintas— y se perdían al limpiar el caché.
--
-- Se mueven a `table_orders`, que ya existe. Estas columnas cubren lo que el
-- modelo de /billing tiene de más:
--   · spots      — una cuenta puede agrupar VARIAS mesas o sillas.
--   · mesero     — responsable (el primero que digitó) y quien digita ahora.
--   · delivery   — sin el 10% de servicio.
--   · color      — para destacar sus mesas en el mapa.
--   · paid       — estado que /billing usa al cobrar.
ALTER TABLE table_orders ADD COLUMN IF NOT EXISTS spots            JSONB;
ALTER TABLE table_orders ADD COLUMN IF NOT EXISTS customer_name    TEXT;
ALTER TABLE table_orders ADD COLUMN IF NOT EXISTS responsible_name TEXT;
ALTER TABLE table_orders ADD COLUMN IF NOT EXISTS waiter_name      TEXT;
ALTER TABLE table_orders ADD COLUMN IF NOT EXISTS is_delivery      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE table_orders ADD COLUMN IF NOT EXISTS color            TEXT;
ALTER TABLE table_orders ADD COLUMN IF NOT EXISTS payment_method   TEXT;

-- Las líneas necesitan el precio base y los modificadores por separado: el total
-- de /billing se calcula como (base + modificadores) × cantidad.
ALTER TABLE table_order_items ADD COLUMN IF NOT EXISTS category_id UUID;
ALTER TABLE table_order_items ADD COLUMN IF NOT EXISTS modifiers   JSONB;
ALTER TABLE table_order_items ADD COLUMN IF NOT EXISTS client_id   TEXT;   -- id de la línea en el cliente

-- El índice único de "una mesa, una cuenta abierta" se vuelve un problema cuando
-- una cuenta agrupa varias mesas (table_id queda como la principal). Se cambia por
-- uno parcial que solo aplica a cuentas de UNA sola mesa.
DROP INDEX IF EXISTS table_orders_one_open;
CREATE UNIQUE INDEX IF NOT EXISTS table_orders_one_open_single
  ON table_orders (tenant_id, table_id)
  WHERE status = 'open' AND (spots IS NULL OR jsonb_array_length(spots) <= 1);
