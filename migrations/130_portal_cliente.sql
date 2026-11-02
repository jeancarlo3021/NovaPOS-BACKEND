-- 130 · PORTAL DEL CLIENTE
--
-- El negocio le manda un enlace a su cliente. El cliente lo abre sin instalar
-- nada ni registrarse: ve SU lista de precios y las existencias, arma el
-- pedido y ve cuánto debe. El pedido cae en la misma bandeja que ya usa la
-- caja, y de ahí al POS para facturarlo.
--
-- ── Por qué NO hay una tabla de pedidos nueva ─────────────────────────────
-- El pedido del cliente es el MISMO `agent_orders` con otro origen. Una tabla
-- paralela significaría dos bandejas, dos formas de cobrar y dos lugares donde
-- arreglar cada cosa; el sistema ya pagó ese precio con las dos pantallas de
-- mesas y no vale la pena repetirlo.

-- ── El enlace ─────────────────────────────────────────────────────────────
-- Uno por cliente. El token es lo único que hace falta para abrir la página, y
-- de él sale el cliente: el servidor NUNCA confía en un id que venga del
-- navegador.
create table if not exists customer_links (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  customer_id   uuid not null references customers(id) on delete cascade,
  token         text not null unique,
  -- Qué puede hacer con el enlace. Los precios se ven siempre; el saldo puede
  -- pedir PIN, porque un enlace se reenvía a un grupo de WhatsApp y lo que se
  -- debe no es información para el grupo.
  puede_pedir   boolean not null default true,
  puede_ver_saldo boolean not null default true,
  pin           text,
  vence_el      date,
  revocado_el   timestamptz,
  ultimo_uso    timestamptz,
  usos          integer not null default 0,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- UN enlace por cliente: si se regenera, se reemplaza el token del mismo.
  unique (tenant_id, customer_id)
);

create index if not exists customer_links_token_idx on customer_links (token);

-- Token imposible de adivinar. 32 bytes en base64 url-safe.
create or replace function nuevo_token_cliente() returns text as $$
  select replace(replace(encode(gen_random_bytes(32), 'base64'), '/', '_'), '+', '-');
$$ language sql volatile;

-- ── De dónde viene el pedido ──────────────────────────────────────────────
-- 'agente' (como hasta hoy) o 'cliente' (del portal). La bandeja los filtra y
-- los muestra distinto: un pedido que armó el cliente se revisa antes de
-- facturarlo, uno del agente ya viene revisado.
alter table agent_orders add column if not exists origen text not null default 'agente';
alter table agent_orders add column if not exists customer_link_id uuid references customer_links(id) on delete set null;
-- Cuándo deja de poder tocarlo el cliente. Se calcula al crearlo con la hora
-- de corte del negocio; después de eso el pedido es de la caja.
alter table agent_orders add column if not exists editable_hasta timestamptz;

create index if not exists agent_orders_origen_idx on agent_orders (tenant_id, origen, status);

comment on column agent_orders.origen is 'agente | cliente — quién armó el pedido';
comment on column agent_orders.editable_hasta is 'Hasta cuándo el cliente puede cambiar o cancelar su pedido';
