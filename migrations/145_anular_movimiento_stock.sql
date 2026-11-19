-- Anular un movimiento de inventario (ajuste o merma).
--
-- Hasta ahora un movimiento era definitivo: una merma tecleada con un cero de
-- más, o un ajuste al producto equivocado, solo se podía "arreglar" metiendo
-- OTRO movimiento en sentido contrario. El stock quedaba bien, pero el reporte
-- quedaba con dos líneas falsas y la merma del mes salía inflada al doble.
--
-- Se ANULA, no se borra: el movimiento sigue en la bitácora —quién lo hizo,
-- cuándo y por qué se anuló—, deja de contar en los totales, y su efecto en el
-- stock se revierte.
ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS voided_by   UUID;
ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- De dónde salió el movimiento.
--
-- No todo movimiento se puede anular desde acá: la recepción de una compra se
-- deshace anulando la compra, y el sobrante de una ruta se corrige en la ruta.
-- Anularlos de este lado dejaría la compra diciendo "recibida" con el stock ya
-- devuelto. Sin esta columna había que adivinarlo por el texto del motivo.
-- NULL = movimiento viejo, de antes de esta columna (se cae al texto).
ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS source TEXT;

-- Una merma de varios productos se registra como varias filas de un mismo acto.
-- Con el lote se anula completa en vez de línea por línea.
ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS batch_id UUID;

CREATE INDEX IF NOT EXISTS idx_adj_batch  ON stock_adjustments (tenant_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_adj_voided ON stock_adjustments (tenant_id, voided_at);
