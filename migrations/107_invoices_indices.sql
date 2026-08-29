-- Índices de las consultas que el sistema hace TODO EL DÍA.
--
-- `invoices` tiene índices por ruta, estado FE, moneda y delivery, pero ninguno
-- para las dos preguntas más frecuentes del sistema:
--
--   1. «facturas de este negocio entre estas dos fechas»  → reportes, cierre de
--      caja, cuentas por cobrar, el panel de control.
--   2. «facturas de esta sesión de caja»                  → el arqueo, cada vez
--      que alguien abre el cierre.
--
-- Sin ellos, cada una de esas consultas recorre TODAS las facturas del negocio.
-- Con pocos cientos no se nota; con decenas de miles —que es a donde va esto—
-- son segundos por consulta, y son consultas que se repiten todo el día.
--
-- `concurrently` NO se usa a propósito: no funciona dentro de una transacción y
-- el editor de Supabase corre todo en una. Estas tablas se bloquean unos
-- segundos mientras se crean los índices: conviene correrlo fuera del horario
-- de venta.

-- 1) Por negocio y fecha, de la más reciente a la más vieja (que es como se pide).
create index if not exists idx_invoices_tenant_issued
  on invoices (tenant_id, issued_at desc);

-- 2) Por sesión de caja. Parcial: las facturas sin caja —ventas de ruta, pedidos
--    de agente— no participan de esta búsqueda y solo engordarían el índice.
create index if not exists idx_invoices_cash_session
  on invoices (cash_session_id)
  where cash_session_id is not null;

-- 3) Las LÍNEAS de cada factura. Se piden en el detalle, al reimprimir, al
--    anular y al emitir a Hacienda: siempre por su factura.
create index if not exists idx_invoice_items_invoice
  on invoice_items (invoice_id);

-- 4) Cuentas por cobrar: la pantalla las pide por negocio ordenadas por fecha, y
--    pagina de mil en mil. Sin índice, cada página vuelve a recorrer la tabla.
create index if not exists idx_ar_tenant_created
  on accounts_receivable (tenant_id, created_at desc);

-- 5) Movimientos de caja por sesión: el arqueo los suma en cada apertura del
--    cierre y en cada venta en efectivo.
create index if not exists idx_cash_movements_session
  on cash_movements (cash_session_id);

-- Actualiza las estadísticas para que el planificador use los índices nuevos
-- desde la primera consulta y no cuando le toque el mantenimiento automático.
analyze invoices;
analyze invoice_items;
analyze accounts_receivable;
analyze cash_movements;
