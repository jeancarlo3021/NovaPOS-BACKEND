-- ════════════════════════════════════════════════════════════════════════════
-- CUADRAR LA BASE CONTRA EL REPORTE DE ALANUBE
--
-- Devuelve UNA fila con los mismos rubros que muestra
-- /reports/emissions-per-company/{id}, para restar y ver qué falta.
--
-- DOS COSAS QUE NO SON OBVIAS Y HACEN CUADRAR MAL:
--
--  1) La NOTA DE CRÉDITO no es una fila aparte. Se guarda EN la factura que
--     anula, en `fe_nc_clave` (y la de débito en `fe_nd_clave`). Buscarla por el
--     tipo dentro de `fe_clave` da siempre cero.
--
--  2) Una factura ANULADA igual se emitió, y Alanube la cuenta. Filtrar por
--     `status <> 'cancelled'` la esconde y hace parecer que falta.
--
-- El tipo va DENTRO de la clave, posiciones 30-31 — no en `document_type`, que
-- es lo que el cajero eligió al cobrar y puede no coincidir con lo emitido:
--     01 = factura   ·  02 = nota de débito
--     03 = nota de crédito  ·  04 = tiquete
-- ════════════════════════════════════════════════════════════════════════════

with p as (
  select
    'cfb43ac5-9611-46a5-9892-4eadd6f05bb2'::uuid as tenant,   -- ← el negocio
    date '2026-08-01'                            as desde,     -- ← mismas fechas
    date '2026-08-31'                            as hasta      --    que en Alanube
),
docs as (
  select i.*
  from invoices i, p
  where i.tenant_id = p.tenant
    -- `hasta` inclusive, igual que dateUntil en Alanube.
    and i.issued_at >= p.desde
    and i.issued_at <  p.hasta + interval '1 day'
)
select
  count(*) filter (
    where fe_clave is not null and length(fe_clave) = 50
      and substring(fe_clave from 30 for 2) = '01'
      and coalesce(fe_status, '') not in ('rejected', 'error')
  ) as invoices,
  count(*) filter (
    where fe_clave is not null and length(fe_clave) = 50
      and substring(fe_clave from 30 for 2) = '04'
      and coalesce(fe_status, '') not in ('rejected', 'error')
  ) as tickets,
  -- La NC vive en la factura anulada, en su propia columna.
  count(*) filter (
    where fe_nc_clave is not null
      and coalesce(fe_nc_status, '') not in ('rejected', 'error')
  ) as "creditNotes",
  count(*) filter (
    where fe_nd_clave is not null
      and coalesce(fe_nd_status, '') not in ('rejected', 'error')
  ) as "debitNotes",
  sum(total) filter (where fe_clave is not null) as monto
from docs;

-- ── ¿CUÁLES faltan? ─────────────────────────────────────────────────────────
-- Lista los consecutivos que SÍ están, por tipo. Los huecos en la numeración
-- son los comprobantes emitidos que no quedaron en la base.
--
-- select
--   substring(i.fe_clave from 30 for 2)          as tipo,
--   substring(i.fe_clave from 32 for 10)::bigint as consecutivo,
--   i.invoice_number, i.issued_at, i.total, i.fe_status, i.status
-- from invoices i
-- where i.tenant_id = 'cfb43ac5-9611-46a5-9892-4eadd6f05bb2'
--   and i.issued_at >= date '2026-08-01'
--   and i.issued_at <  date '2026-08-31' + interval '1 day'
--   and i.fe_clave is not null and length(i.fe_clave) = 50
-- order by tipo, consecutivo;
