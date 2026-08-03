-- Nota por LÍNEA de factura (para comidas: "sin cebolla", "término medio", …).
-- Se captura en el carrito del POS y viaja con el item hasta la factura, para que
-- salga impresa en el tiquete/comanda y quede en el histórico de la venta.
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS notes TEXT;
