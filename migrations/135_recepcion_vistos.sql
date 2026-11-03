-- 135 · CORREOS YA MIRADOS EN LA RECEPCIÓN
--
-- El cron recorre los últimos 15 días del buzón en CADA corrida, de lo más
-- nuevo a lo más viejo, y se detiene cuando se le acaba el tiempo. Como no
-- recordaba nada entre corridas, cada vuelta volvía a bajar los MISMOS
-- primeros correos: con presupuesto para tres, procesaba tres veces los
-- mismos tres y el resto del buzón no se tocaba nunca.
--
-- Acá se anota qué correos ya se miraron. La próxima corrida los saltea sin
-- descargarlos —que es lo caro— y avanza de verdad sobre lo que falta.
--
-- Por qué no alcanzaba con la marca de «leído» del correo:
--  · solo se marca a los que traían comprobante, así que los correos sin XML
--    se volvían a bajar para siempre;
--  · un humano que abre un correo lo marca leído sin haberlo procesado.
--
-- `uidvalidity` no es un detalle: si el servidor la cambia, los uid de ese
-- buzón se reasignan y lo anotado deja de significar lo mismo. Guardarla
-- permite descartar lo viejo en vez de saltear correos equivocados.

CREATE TABLE IF NOT EXISTS public.recepcion_correos_vistos (
  -- La cuenta IMAP: si se cambia de buzón de recepción, los uid no sirven.
  cuenta      TEXT NOT NULL,
  buzon       TEXT NOT NULL,
  uidvalidity BIGINT,
  uid         BIGINT NOT NULL,
  /** Si traía comprobante. Sirve para saber qué tanto spam se está mirando. */
  con_comprobante BOOLEAN NOT NULL DEFAULT false,
  visto_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cuenta, buzon, uid)
);

CREATE INDEX IF NOT EXISTS recepcion_vistos_limpieza
  ON public.recepcion_correos_vistos (visto_at);

COMMENT ON TABLE public.recepcion_correos_vistos IS
  'Correos ya examinados por el cron de recepción, para no volver a descargarlos.';

NOTIFY pgrst, 'reload schema';
