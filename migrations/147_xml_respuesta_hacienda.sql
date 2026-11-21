-- 147 · GUARDAR EL XML DE RESPUESTA DE HACIENDA
--
-- Un comprobante electrónico entregado son DOS archivos: el XML firmado de la
-- factura y el XML de la ACEPTACIÓN de Hacienda. Los portales de proveedores
-- grandes —Colono, por ejemplo— no dan por recibida una factura hasta tener la
-- aceptación: la marcan «SIN RECIBIR» aunque Hacienda ya la haya aceptado.
--
-- El XML de la factura ya se guardaba (`fe_xml`); el de la respuesta no: se le
-- pedía al proveedor JUSTO al mandar el correo. Si en ese momento Hacienda
-- todavía no había contestado, el correo salía solo con la factura y el
-- comprobante quedaba marcado como enviado para siempre. Nadie lo volvía a
-- mandar, y el cliente nunca recibía la aceptación.
--
-- Guardándolo, el correo lo lleva siempre: la primera vez desde el proveedor y
-- de ahí en adelante desde acá, sin depender de que el proveedor siga en pie ni
-- de que conserve el documento.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS fe_xml_hacienda TEXT;

COMMENT ON COLUMN public.invoices.fe_xml_hacienda IS
  'XML de respuesta (aceptación) de Hacienda. Va adjunto en el correo junto al XML de la factura.';

NOTIFY pgrst, 'reload schema';
