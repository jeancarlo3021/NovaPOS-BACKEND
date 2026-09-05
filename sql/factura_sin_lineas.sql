-- ¿Por qué una factura dice "no tiene líneas de detalle para emitir"?
-- Cambiá el número de factura y el tenant.
select
  i.id,
  i.invoice_number,
  i.document_type,
  i.total,
  i.fe_status,
  i.created_at,
  count(it.id)                                     as lineas_guardadas,
  count(*) filter (where p.exclude_from_fe)         as excluidas_de_hacienda,
  count(*) filter (where coalesce(it.subtotal, 0) = 0
                     and coalesce(it.unit_price, 0) = 0) as sin_precio
from invoices i
left join invoice_items it on it.invoice_id = i.id
left join products      p  on p.id = it.product_id
where i.tenant_id = 'PONE-EL-TENANT-ID'
  and i.invoice_number = '000012'
group by i.id;

-- lineas_guardadas = 0  -> la factura nació sin detalle: hay que rehacer la venta.
-- excluidas = lineas    -> los productos están marcados "no enviar a Hacienda".
-- sin_precio = lineas   -> todo quedó en cero y no hay nada que declarar.
