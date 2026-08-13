-- Cuándo se canceló una cuenta, y qué abonos fueron del mismo pago.
--
-- ── El problema ────────────────────────────────────────────────────────────
-- Cuando una cuenta se termina de pagar, lo único que quedaba era `status =
-- 'paid'` y un `updated_at` que cambia con cualquier edición posterior. O sea:
-- no había forma de responder «¿cuándo canceló este cliente?», que es justo lo
-- que se pregunta cuando reclama, o cuando hay que medir en cuánto tiempo cobra
-- el negocio.
ALTER TABLE public.accounts_receivable
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- Las cuentas YA canceladas se rellenan con la fecha del último abono, que es lo
-- más cercano a la verdad que existe en los datos. Es una aproximación y por eso
-- solo se aplica donde no hay nada: sobrescribir un dato real con una estimación
-- sería peor que no tenerlo.
UPDATE public.accounts_receivable ar
   SET paid_at = sub.last_pay
  FROM (
    SELECT receivable_id, MAX(created_at) AS last_pay
      FROM public.accounts_receivable_payments
     WHERE voided_at IS NULL
     GROUP BY receivable_id
  ) sub
 WHERE ar.id = sub.receivable_id
   AND ar.status = 'paid'
   AND ar.paid_at IS NULL;

-- ── Abonos masivos ─────────────────────────────────────────────────────────
-- Un cliente entrega UN monto que se reparte entre varias facturas. Sin esto,
-- en la base quedan cinco abonos sueltos y nadie puede reconstruir que fueron
-- un solo pago — ni para reimprimir el recibo, ni para anularlo completo si se
-- registró mal.
ALTER TABLE public.accounts_receivable_payments
  ADD COLUMN IF NOT EXISTS batch_id UUID;

CREATE INDEX IF NOT EXISTS idx_ar_payments_batch
  ON public.accounts_receivable_payments (batch_id) WHERE batch_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
