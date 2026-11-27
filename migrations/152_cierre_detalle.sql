-- El DETALLE del cierre de caja, tal como se imprimió.
--
-- Hasta ahora del cierre se guardaba el monto contado, la hora y la nota: todo
-- lo demás —el conteo por denominación, lo contado por método, los abonos del
-- turno, los movimientos del fondo, las ventas a crédito— vivía solo en el
-- papel. Si el tiquete se perdía, se mojaba o la impresora se quedó sin rollo,
-- el arqueo de ese turno no se podía volver a sacar: quedaba un número sin
-- respaldo.
--
-- Acá se guarda el mismo objeto que se mandó a imprimir, para poder reimprimir
-- el cierre idéntico desde Reportes.
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS cierre_detalle JSONB;

COMMENT ON COLUMN cash_sessions.cierre_detalle IS
  'Detalle del cierre tal como se imprimió (ver printCashClose). Permite reimprimir el arqueo idéntico. NULL en las cajas cerradas antes de esta columna: esas se rearman desde las ventas del turno.';
