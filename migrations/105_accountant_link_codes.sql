-- Enlazar un negocio YA EXISTENTE con su contador.
--
-- El contador no puede engancharse a un negocio por su cuenta: eso le daría
-- acceso a la facturación de cualquiera con solo saber el nombre. El negocio
-- genera un código, se lo pasa a su contador, y el contador lo canjea. La
-- autorización sale del negocio, que es de quien tiene que salir.
create table if not exists accountant_link_codes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  -- Corto y legible: se dicta por teléfono o WhatsApp.
  code        text not null,
  created_by  uuid,
  -- Caduca: un código que sirve para siempre es una llave suelta.
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     uuid,
  created_at  timestamptz not null default now()
);

create unique index if not exists accountant_link_codes_code_key
  on accountant_link_codes (upper(code));
create index if not exists accountant_link_codes_tenant_idx
  on accountant_link_codes (tenant_id);
