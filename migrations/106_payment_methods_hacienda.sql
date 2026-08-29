-- Medios de pago que Hacienda reconoce y la base todavía rechazaba.
--
-- El comprobante electrónico lleva un código de medio de pago:
--   01 efectivo · 02 tarjeta · 03 cheque · 04 transferencia
--   05 recaudado por terceros · 06 SINPE móvil · 07 plataforma digital · 99 otros
--
-- Faltaban dos en la restricción de la tabla, y son de uso diario:
--   · 'third_party' (05): la venta por plataforma de delivery, donde el cliente
--     le paga a Uber o PedidosYa y la plataforma le deposita al negocio.
--   · 'digital'     (07): billeteras y plataformas de pago.
-- Guardarlos como «otros» era declararle a Hacienda un 99 en vez del código real.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payment_method_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_payment_method_check CHECK (
  payment_method IN (
    'cash', 'card', 'sinpe', 'check', 'transfer', 'credit', 'mixed', 'other',
    'third_party', 'digital'
  )
);
