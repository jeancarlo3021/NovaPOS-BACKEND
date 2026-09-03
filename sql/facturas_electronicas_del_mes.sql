-- ════════════════════════════════════════════════════════════════════════════
-- ¿CUÁNTOS COMPROBANTES ELECTRÓNICOS HAY ESTE MES?
--
-- Para pegar en el editor SQL de Supabase. No cambia nada.
--
-- Cuenta por TIPO REAL: el que Hacienda recibió, no el que el cajero eligió al
-- cobrar. El tipo va dentro de la clave, en las posiciones 30 y 31:
--     01 = factura electrónica    ·  04 = tiquete electrónico
--     03 = nota de crédito        ·  02 = nota de débito
-- Una venta marcada como electrónica que nunca se emitió NO tiene clave: para
-- Hacienda es un comprobante corriente, y por eso se cuenta aparte.
-- ════════════════════════════════════════════════════════════════════════════

-- Cambiá el mes acá (primer día del mes que querés mirar).
with rango as (
  select date_trunc('month', current_date) as desde,
         date_trunc('month', current_date) + interval '1 month' as hasta
),
base as (
  select
    i.tenant_id,
    t.name as negocio,
    case
      when i.fe_clave is null or length(i.fe_clave) <> 50 then 'sin emitir (corriente)'
      when substring(i.fe_clave from 30 for 2) = '01' then 'factura electrónica'
      when substring(i.fe_clave from 30 for 2) = '04' then 'tiquete electrónico'
      when substring(i.fe_clave from 30 for 2) = '03' then 'nota de crédito'
      when substring(i.fe_clave from 30 for 2) = '02' then 'nota de débito'
      else 'otro'
    end as tipo,
    -- Los RECHAZADOS no son comprobantes válidos: se separan para que no
    -- inflen el conteo de lo que sí se puede declarar.
    coalesce(i.fe_status, 'sin estado') as estado,
    i.total
  from invoices i
  join tenants t on t.id = i.tenant_id
  cross join rango r
  where i.issued_at >= r.desde
    and i.issued_at <  r.hasta
    and coalesce(i.status, '') <> 'cancelled'
)
select
  negocio,
  tipo,
  estado,
  count(*)      as cantidad,
  sum(total)    as monto
from base
group by negocio, tipo, estado
order by negocio, tipo, estado;

-- ── Resumen corto: solo lo declarable, por tipo ─────────────────────────────
-- Descomentá este bloque (y comentá el select de arriba) para verlo resumido.
--
-- with rango as (
--   select date_trunc('month', current_date) as desde,
--          date_trunc('month', current_date) + interval '1 month' as hasta
-- )
-- select
--   t.name as negocio,
--   count(*) filter (where substring(i.fe_clave from 30 for 2) = '01') as facturas_electronicas,
--   count(*) filter (where substring(i.fe_clave from 30 for 2) = '04') as tiquetes_electronicos,
--   count(*) filter (where i.fe_clave is null)                          as sin_emitir,
--   count(*) filter (where i.fe_status in ('rejected', 'error'))        as rechazados
-- from invoices i
-- join tenants t on t.id = i.tenant_id
-- cross join rango r
-- where i.issued_at >= r.desde and i.issued_at < r.hasta
--   and coalesce(i.status, '') <> 'cancelled'
-- group by t.name
-- order by t.name;
