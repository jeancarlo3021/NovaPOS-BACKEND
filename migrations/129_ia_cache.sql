-- 129 · CACHÉ DE RESPUESTAS DE IA
--
-- La llamada más barata es la que no se hace. Las preguntas se repiten mucho
-- —el mismo producto a clasificar, la misma duda sobre cómo hacer una nota de
-- crédito— y pagar dos veces por la misma respuesta no tiene sentido.
--
-- La clave es un sha256 de (proveedor + modelo + tope de salida + ámbito +
-- instrucciones + mensaje): si cambia cualquiera de esas cosas, es otra
-- pregunta y se vuelve a consultar.
--
-- Sin esta tabla el sistema funciona igual, solo que guardando en memoria del
-- proceso (se pierde en cada despliegue).

create table if not exists ia_cache (
  clave       text primary key,
  respuesta   text not null,
  modelo      text,
  usos        integer not null default 1,
  usos_extra  integer,                       -- lo suma el disparador de abajo
  vence_el    timestamptz,
  ultimo_uso  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists ia_cache_vence_idx on ia_cache (vence_el);

-- `usos_extra` llega como 1 desde el código (un upsert no puede sumar); el
-- disparador lo convierte en una suma real sobre `usos`. Así se puede ver
-- cuánto ahorró la caché sin leer registros.
create or replace function ia_cache_sumar_uso() returns trigger as $$
begin
  if new.usos_extra is not null then
    new.usos := coalesce(old.usos, 0) + new.usos_extra;
    new.usos_extra := null;
    new.respuesta := coalesce(new.respuesta, old.respuesta);
    new.vence_el := coalesce(new.vence_el, old.vence_el);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists ia_cache_uso on ia_cache;
create trigger ia_cache_uso before update on ia_cache
  for each row execute function ia_cache_sumar_uso();

-- Limpieza: lo vencido hace más de una semana no le sirve a nadie.
-- (se puede correr a mano o desde el cron del sistema)
-- delete from ia_cache where vence_el < now() - interval '7 days';

-- ── CONSUMO DE CRÉDITOS DE IA POR NEGOCIO Y MES ───────────────────────────
--
-- Cuántas consultas al modelo gastó cada negocio en el mes. El tope lo pone el
-- plan (`features.ia_creditos`) y se controla desde el panel de planes.
--
-- `suma` es la columna por la que entra el movimiento (+1 al gastar, -1 si la
-- consulta falló): un upsert no puede sumar por sí mismo, así que el disparador
-- la convierte en una suma real sobre `consultas` y la vuelve a dejar en cero.

create table if not exists ia_uso (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  mes         text not null,                       -- «2026-10», hora de Costa Rica
  consultas   integer not null default 0,
  suma        integer,
  actualizado timestamptz not null default now(),
  primary key (tenant_id, mes)
);

create or replace function ia_uso_sumar() returns trigger as $$
begin
  if new.suma is not null then
    new.consultas := greatest(0, coalesce(old.consultas, 0) + new.suma);
    new.suma := null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists ia_uso_suma on ia_uso;
create trigger ia_uso_suma before update on ia_uso
  for each row execute function ia_uso_sumar();

-- En el INSERT el disparador de arriba no corre, así que la primera consulta
-- del mes entra con `consultas = 1` desde este otro.
create or replace function ia_uso_primera() returns trigger as $$
begin
  if new.suma is not null then
    new.consultas := greatest(0, new.suma);
    new.suma := null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists ia_uso_alta on ia_uso;
create trigger ia_uso_alta before insert on ia_uso
  for each row execute function ia_uso_primera();
