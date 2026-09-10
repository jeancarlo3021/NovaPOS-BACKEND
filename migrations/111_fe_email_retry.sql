-- REINTENTO del correo del comprobante.
--
-- El correo al cliente salía UNA sola vez: en el instante en que el comprobante
-- pasaba a «aceptado». Si ese intento fallaba —Alanube todavía no publicaba el
-- XML, el servicio de correo no respondía, se agotaba el tiempo— no había nada
-- que lo volviera a intentar. El comprobante quedaba sin enviar para siempre, y
-- nadie se enteraba hasta que el cliente reclamaba su factura.
--
-- Con estas dos columnas un barrido periódico puede reintentar con espera entre
-- intentos y con tope, sin martillar un comprobante cuyo XML nunca va a llegar.
alter table public.invoices
  add column if not exists fe_email_attempts     int not null default 0,
  add column if not exists fe_email_last_attempt timestamptz;

-- Solo los que interesan al barrido: aceptados y sin enviar. Índice parcial para
-- que la consulta no recorra todas las facturas del negocio cada 15 minutos.
create index if not exists idx_invoices_fe_email_pendiente
  on public.invoices (tenant_id, fe_email_last_attempt)
  where fe_status = 'accepted' and fe_emailed is not true and fe_clave is not null;
