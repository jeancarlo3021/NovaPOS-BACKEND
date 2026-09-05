-- ════════════════════════════════════════════════════════════════════════════
-- ¿QUÉ CONSECUTIVOS FALTAN EN LA BASE?
--
-- Hacienda numera de corrido por tipo. Si la base tiene 19 facturas y Hacienda
-- 44, los que faltan son los HUECOS en esa numeración: esta consulta los saca
-- sin tener que compararlos a mano.
--
-- Ojo: solo encuentra huecos ENTRE el primero y el último que sí están. Si lo
-- que falta es una cola al final (o un tramo antes del primero), se ve en el
-- bloque 3, que muestra el rango cubierto.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1) HUECOS de FACTURAS (tipo 01) ─────────────────────────────────────────
with p as (
  select
    'cfb43ac5-9611-46a5-9892-4eadd6f05bb2'::uuid as tenant,
    date '2026-08-01' as desde,
    date '2026-08-31' as hasta,
    '01'              as tipo          -- ← '04' para tiquetes, '03' para NC
),
presentes as (
  select distinct substring(i.fe_clave from 32 for 10)::bigint as consecutivo
  from invoices i, p
  where i.tenant_id = p.tenant
    and i.issued_at >= p.desde
    and i.issued_at <  p.hasta + interval '1 day'
    and i.fe_clave is not null
    and length(i.fe_clave) = 50
    and substring(i.fe_clave from 30 for 2) = p.tipo
),
rango as (select min(consecutivo) as lo, max(consecutivo) as hi from presentes)
select g.n as consecutivo_que_falta
from rango r, generate_series(r.lo, r.hi) as g(n)
where not exists (select 1 from presentes x where x.consecutivo = g.n)
order by 1;

-- ── 2) LO QUE SOBRA: comprobantes con clave que Hacienda podría no tener ────
-- Alanube cuenta lo ACEPTADO. Una clave guardada con estado raro (o sin estado)
-- puede ser algo que nunca llegó a aceptarse, o que se emitió con otra cuenta.
--
-- select
--   substring(i.fe_clave from 30 for 2) as tipo,
--   coalesce(i.fe_status, '(sin estado)') as estado,
--   count(*)
-- from invoices i
-- where i.tenant_id = 'cfb43ac5-9611-46a5-9892-4eadd6f05bb2'
--   and i.issued_at >= date '2026-08-01'
--   and i.issued_at <  date '2026-08-31' + interval '1 day'
--   and i.fe_clave is not null and length(i.fe_clave) = 50
-- group by 1, 2
-- order by 1, 2;

-- ── 3) RANGO CUBIERTO por tipo: primero y último consecutivo que hay ────────
-- Si Hacienda tiene 44 facturas y acá el rango va del 900 al 918 sin huecos,
-- entonces lo que falta NO está en el medio: son consecutivos anteriores o
-- posteriores, y hay que buscarlos por fuera de este mes.
--
-- select
--   substring(i.fe_clave from 30 for 2) as tipo,
--   count(*) as cantidad,
--   min(substring(i.fe_clave from 32 for 10)::bigint) as primero,
--   max(substring(i.fe_clave from 32 for 10)::bigint) as ultimo
-- from invoices i
-- where i.tenant_id = 'cfb43ac5-9611-46a5-9892-4eadd6f05bb2'
--   and i.issued_at >= date '2026-08-01'
--   and i.issued_at <  date '2026-08-31' + interval '1 day'
--   and i.fe_clave is not null and length(i.fe_clave) = 50
-- group by 1
-- order by 1;
