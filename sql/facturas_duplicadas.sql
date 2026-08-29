-- ════════════════════════════════════════════════════════════════════════════
-- FACTURAS DOBLES — diagnóstico
--
-- Esto NO es una migración: no cambia nada. Es una consulta para pegar en el
-- editor SQL de Supabase y ver qué cobros salieron dos veces.
--
-- Qué busca: dos facturas del MISMO negocio, por el MISMO monto, en la MISMA
-- caja y con MENOS DE 12 SEGUNDOS de diferencia.
--
-- ── Por qué doce segundos y no tres minutos ────────────────────────────────
-- Con una ventana de minutos, la consulta marca montones de ventas legítimas:
-- un distribuidor que vende la misma caja de ₡18.500 a cinco pulperías seguidas,
-- o una soda que cobra el mismo combo de ₡3.700 toda la mañana. Eso es su
-- negocio funcionando, no un error.
--
-- Un duplicado de verdad nace de UN solo cobro: el doble toque en el botón o un
-- reintento que entró dos veces. Ninguno de los dos tarda medio minuto. Doce
-- segundos deja pasar el doble toque (1-2 s) y el reintento por tiempo agotado
-- (hasta ~10 s) sin arrastrar la venta repetida de verdad.
--
-- Además se exige el MISMO cliente: dos ventas del mismo monto a clientes
-- distintos son dos ventas, por más juntas que estén.
--
-- Las anuladas quedan fuera: si ya se corrigió, no hay nada que revisar.
-- ════════════════════════════════════════════════════════════════════════════

with pares as (
  select
    a.tenant_id,
    a.id             as id_original,
    a.invoice_number as numero_original,
    a.issued_at      as hora_original,
    b.id             as id_duplicada,
    b.invoice_number as numero_duplicada,
    b.issued_at      as hora_duplicada,
    a.total,
    a.customer_name,
    a.payment_method,
    a.document_type,
    -- Si la copia llegó a Hacienda, no alcanza con anularla en el sistema:
    -- hay que emitirle una nota de crédito.
    b.fe_clave       as clave_hacienda_duplicada,
    b.fe_status      as estado_fe_duplicada,
    extract(epoch from (b.issued_at - a.issued_at))::int as segundos_entre
  from invoices a
  join invoices b
    on  b.tenant_id = a.tenant_id
    and b.total     = a.total
    and b.id       <> a.id
    -- La misma caja. Si alguna no la tiene, se acepta el mismo día.
    and (
      (a.cash_session_id is not null and b.cash_session_id = a.cash_session_id)
      or (a.cash_session_id is null and b.cash_session_id is null
          and date(b.issued_at) = date(a.issued_at))
    )
    -- `b` es la copia: la que entró DESPUÉS, dentro de la misma ventana.
    and b.issued_at > a.issued_at
    and b.issued_at <= a.issued_at + interval '12 seconds'
    -- Mismo cliente (o ninguno en ambas): si son clientes distintos, son ventas
    -- distintas aunque cueste lo mismo.
    and coalesce(b.customer_name, '') = coalesce(a.customer_name, '')
    and coalesce(b.customer_id::text, '') = coalesce(a.customer_id::text, '')
  where coalesce(a.status, '') <> 'cancelled'
    and coalesce(b.status, '') <> 'cancelled'
    and a.total > 0
)
select *
from pares
order by tenant_id, hora_original desc;

-- ── Resumen por negocio ─────────────────────────────────────────────────────
-- Para saber de un vistazo a quién le pasó y cuánta plata está duplicada.
--
-- select t.name as negocio,
--        count(*)      as facturas_duplicadas,
--        sum(p.total)  as monto_duplicado
-- from pares p join tenants t on t.id = p.tenant_id
-- group by t.name order by monto_duplicado desc;
