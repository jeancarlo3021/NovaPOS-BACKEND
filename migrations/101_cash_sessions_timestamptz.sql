-- 101 · Fechas de caja con zona horaria.
--
-- `opening_date` y `closing_date` eran `timestamp SIN zona` y el backend guarda
-- ahí el instante en UTC. El texto sale como "2026-08-26 14:20:00" —sin marca—
-- y cualquier cliente que lo lea lo toma como hora local: una apertura de las
-- 8:20 a.m. se mostraba a las 2:20 p.m.
--
-- Se convierten a `timestamptz` declarando que lo guardado ES UTC, así el
-- instante no se mueve y de ahora en adelante la zona viaja con el dato.

ALTER TABLE public.cash_sessions
  ALTER COLUMN opening_date TYPE TIMESTAMPTZ USING opening_date AT TIME ZONE 'UTC';

ALTER TABLE public.cash_sessions
  ALTER COLUMN closing_date TYPE TIMESTAMPTZ USING closing_date AT TIME ZONE 'UTC';

NOTIFY pgrst, 'reload schema';
