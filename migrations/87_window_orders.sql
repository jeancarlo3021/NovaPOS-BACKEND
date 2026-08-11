-- Ventanita: servicio de mostrador con número de orden.
--
-- Es el mismo negocio de comidas que el salón, pero al revés: acá se cobra
-- PRIMERO y el cliente espera de pie a que lo llamen. No hay mesa que ocupar ni
-- cuenta que se acumule, así que `table_orders` no sirve: aquella tabla existe
-- para lo contrario, ir sumando rondas y cobrar al final.
--
-- Lo que sí hace falta y no existía es la FILA: qué pedidos están en cocina, en
-- qué orden llegaron y cuáles ya se pueden entregar. Hoy eso vive en la cabeza
-- del que despacha, y cuando hay cola se traspapela.
CREATE TABLE IF NOT EXISTS public.window_orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,

  -- Número que se le canta al cliente. Se reinicia CADA DÍA: un número de tres
  -- cifras es más fácil de gritar y de oír que el consecutivo de la factura, y
  -- que se repita mañana no molesta a nadie porque la fila ya se vació.
  number       INT  NOT NULL,
  day          DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'America/Costa_Rica')::date,

  -- Venta que lo originó. La plata ya se cobró: esta tabla es solo despacho.
  invoice_id   UUID,
  customer_name TEXT,

  -- Bipper físico que se le entregó al cliente.
  --
  -- Es TEXTO y no un número: los bippers vienen rotulados «A3», «12», «Rojo-4»,
  -- y forzar un entero obligaría al cajero a traducir mentalmente lo que tiene
  -- en la mano. Va aparte del número de orden porque son dos cosas distintas:
  -- el número identifica el pedido en la fila y no se repite en el día; el
  -- bipper es un aparato que se presta, se devuelve y se vuelve a prestar.
  bipper       TEXT,

  -- pending  → en cocina
  -- ready    → listo, hay que llamar al cliente
  -- delivered→ entregado
  -- cancelled→ se anuló
  status       TEXT NOT NULL DEFAULT 'pending',

  -- Resumen de lo pedido, para el tablero. Se guarda en la fila y no se lee de
  -- la factura a propósito: el tablero se refresca cada pocos segundos y no
  -- puede pagar un JOIN con los ítems en cada vuelta.
  items_summary TEXT,
  total        NUMERIC NOT NULL DEFAULT 0,
  notes        TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at     TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);

-- ── Columnas agregadas después de la primera versión ───────────────────────
-- `CREATE TABLE IF NOT EXISTS` NO agrega columnas a una tabla que ya existe: si
-- alguien corrió una versión anterior de este archivo, la tabla se quedó como
-- estaba y todo lo que venga abajo referenciando una columna nueva revienta.
-- Estos ALTER hacen que el archivo se pueda correr las veces que haga falta.
ALTER TABLE public.window_orders
  ADD COLUMN IF NOT EXISTS bipper        TEXT,
  ADD COLUMN IF NOT EXISTS invoice_id    UUID,
  ADD COLUMN IF NOT EXISTS customer_name TEXT,
  ADD COLUMN IF NOT EXISTS items_summary TEXT,
  ADD COLUMN IF NOT EXISTS notes         TEXT,
  ADD COLUMN IF NOT EXISTS ready_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at  TIMESTAMPTZ;

-- Un número por día y por negocio. Es lo que evita dos órdenes «14» en la fila
-- cuando dos cajas despachan al mismo tiempo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_window_orders_num
  ON public.window_orders (tenant_id, day, number);

CREATE INDEX IF NOT EXISTS idx_window_orders_queue
  ON public.window_orders (tenant_id, status, created_at);

-- Bippers ocupados: los que están en la calle con un pedido vivo. Sirve para
-- avisar antes de entregar dos veces el mismo aparato.
CREATE INDEX IF NOT EXISTS idx_window_orders_bipper
  ON public.window_orders (tenant_id, bipper) WHERE status IN ('pending', 'ready');

-- Siguiente número del día, atómico.
--
-- Con dos cajas despachando a la vez, un SELECT MAX seguido de un INSERT entrega
-- el mismo número dos veces. Acá el número sale de la propia inserción, que ya
-- está serializada por el índice único.
CREATE OR REPLACE FUNCTION public.next_window_number(p_tenant UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_day  DATE := (NOW() AT TIME ZONE 'America/Costa_Rica')::date;
  v_next INT;
BEGIN
  SELECT COALESCE(MAX(number), 0) + 1 INTO v_next
    FROM public.window_orders
   WHERE tenant_id = p_tenant AND day = v_day;
  RETURN v_next;
END;
$$;

NOTIFY pgrst, 'reload schema';
