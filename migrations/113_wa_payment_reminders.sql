-- AVISOS DE COBRO ya enviados.
--
-- El aviso de vencimiento sale a los 7, 4, 2 y 1 días. El proceso que los manda
-- corre cada pocos minutos, así que sin dejar constancia el cliente recibiría el
-- mismo mensaje decenas de veces en un día.
--
-- La clave única es (negocio, vencimiento, umbral): un aviso por cada uno. Si al
-- negocio se le renueva la suscripción, el vencimiento cambia y vuelve a
-- corresponderle su tanda de avisos.
create table if not exists public.wa_payment_reminders (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  ends_at    date not null,
  days       int  not null,
  sent_at    timestamptz not null default now()
);

create unique index if not exists uq_wa_payment_reminder
  on public.wa_payment_reminders (tenant_id, ends_at, days);

comment on table public.wa_payment_reminders is
  'Avisos de cobro por WhatsApp ya enviados, para no repetirlos.';
