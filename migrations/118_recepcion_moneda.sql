-- RECEPCIÓN DE FACTURAS: EN QUÉ MONEDA VIENE CADA COMPROBANTE.
--
-- Los montos del XML vienen en la moneda del emisor, y hasta ahora se
-- guardaban como si siempre fueran colones. En la bandeja de hoy eso ya pasó
-- seis veces con datos reales:
--
--   ALANUBE SOLUCIONES    US$    56,50 × 449,80  →  ₡25.414   (guardado: ₡56,50)
--   KAIMANDUC S.A.        US$ 3.390,00 × 450,00  →  ₡1.525.500 (guardado: ₡3.390)
--   SEGUROS IS-CR         US$     3,50 × 507,78  →  ₡1.777    (guardado: ₡3,50)
--
-- No es solo cosmético: ese total alimenta el borrador de compra y el gasto.
-- Una factura de un millón y medio entrando como tres mil colones descuadra la
-- contabilidad del mes sin que nada avise.

ALTER TABLE public.received_documents
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CRC',
  -- Colones por una unidad de la moneda. 1 cuando el comprobante es en colones.
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(14,5) NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.received_documents.currency IS
  'Moneda del comprobante según el XML (CodigoTipoMoneda/CodigoMoneda). CRC si no viene.';
COMMENT ON COLUMN public.received_documents.exchange_rate IS
  'Tipo de cambio DECLARADO POR EL EMISOR en el XML, no el del día: es el que usó para calcular los impuestos de ese comprobante.';

-- Relleno de lo ya recibido, leyendo el XML guardado.
--
-- Se saca del propio comprobante y no del tipo de cambio de hoy: el de hoy
-- daría un total distinto al del papel que mandó el proveedor. Los que no
-- tienen XML o no traen la etiqueta quedan en CRC, que es lo que Hacienda
-- define por omisión y lo que el sistema ya asumía.
UPDATE public.received_documents
   SET currency = COALESCE(
         NULLIF(UPPER(SUBSTRING(xml FROM '<CodigoMoneda>\s*([A-Za-z]{3})\s*</CodigoMoneda>')), ''),
         'CRC'),
       exchange_rate = COALESCE(
         NULLIF(SUBSTRING(xml FROM '<TipoCambio>\s*([0-9.]+)\s*</TipoCambio>'), '')::NUMERIC,
         1)
 WHERE xml IS NOT NULL
   AND xml ~ '<CodigoMoneda>'
   AND currency = 'CRC';

-- Un comprobante en moneda extranjera SIN tipo de cambio no se puede convertir,
-- y poner 1 lo haría pasar por colones en silencio. Se deja en 0 a propósito:
-- la pantalla lo muestra como «falta el tipo de cambio» y lo pide.
UPDATE public.received_documents
   SET exchange_rate = 0
 WHERE currency <> 'CRC' AND exchange_rate = 1;

NOTIFY pgrst, 'reload schema';
