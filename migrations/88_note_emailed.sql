-- Marca de «la nota ya se le envió al cliente».
--
-- La factura tenía `fe_emailed` desde siempre, pero las notas no: al aceptarse
-- una nota de crédito nadie se la mandaba al cliente, y ahora que sí se envía
-- hace falta dónde anotarlo. Sin esto, cada consulta de estado que devolviera
-- «aceptada» dispararía otro correo con el mismo comprobante.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS fe_nc_emailed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fe_nd_emailed BOOLEAN NOT NULL DEFAULT false;

-- Las notas ya emitidas antes de esto quedan SIN marcar a propósito: si el
-- cliente nunca recibió la suya, que le llegue la próxima vez que se consulte el
-- estado. Marcarlas como enviadas taparía justo lo que hay que corregir.

NOTIFY pgrst, 'reload schema';
