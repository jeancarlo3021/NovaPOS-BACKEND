-- APARTADOS (reservación de artículos).
--
-- El cliente separa mercadería, abona una parte y la retira después. Es una
-- venta que todavía no ocurrió: hasta que se entrega no hay factura, no entra al
-- cierre de caja como venta y no se declara a Hacienda. Lo que sí ocurre desde
-- el primer día es que la mercadería SALE del inventario disponible — está
-- apartada, con el nombre del cliente encima— y que el negocio recibe plata.
create table if not exists reservations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  number        text,
  customer_id   uuid,
  customer_name text,
  customer_phone text,
  -- 'open' apartado vigente · 'delivered' entregado (ya facturado)
  -- 'cancelled' anulado · 'expired' vencido sin retirar
  status        text not null default 'open'
                check (status in ('open', 'delivered', 'cancelled', 'expired')),
  total         numeric(14,2) not null default 0,
  -- Lo abonado hasta ahora. Se mantiene al día con cada abono para no tener que
  -- sumar la tabla de pagos cada vez que se lista.
  paid          numeric(14,2) not null default 0,
  -- Hasta cuándo se guarda. Vencida, la mercadería vuelve a la venta.
  expires_on    date,
  notes         text,
  -- Factura que se generó al entregarlo.
  invoice_id    uuid,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists reservation_items (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references reservations(id) on delete cascade,
  product_id     uuid,
  product_name   text not null,
  quantity       numeric(14,3) not null default 1,
  unit_price     numeric(14,2) not null default 0,
  subtotal       numeric(14,2) not null default 0
);

-- Cada abono queda registrado: el cliente puede abonar de a poco y hay que poder
-- decirle cuándo pagó cada parte, no solo el acumulado.
create table if not exists reservation_payments (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references reservations(id) on delete cascade,
  tenant_id      uuid not null,
  amount         numeric(14,2) not null,
  method         text not null default 'cash',
  notes          text,
  -- Sesión de caja en la que entró la plata, para que el arqueo cuadre.
  cash_session_id uuid,
  created_by     uuid,
  created_at     timestamptz not null default now()
);

create index if not exists idx_reservations_tenant_status
  on reservations (tenant_id, status, created_at desc);
create index if not exists idx_reservations_customer
  on reservations (customer_id);
create index if not exists idx_reservation_items_res
  on reservation_items (reservation_id);
create index if not exists idx_reservation_payments_res
  on reservation_payments (reservation_id);
