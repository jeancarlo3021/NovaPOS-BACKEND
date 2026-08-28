-- Identificador de la venta hecha SIN CONEXIÓN.
--
-- Evita cobrar dos veces lo mismo. Una venta offline se sube con reintentos; si
-- la primera llamada llegó al servidor pero la respuesta se perdió (se cortó la
-- señal, venció el tiempo de espera), el aparato la sigue viendo como pendiente
-- y la vuelve a mandar. Sin esta marca, el servidor crea una SEGUNDA factura: la
-- venta queda duplicada, el inventario se descuenta dos veces y el cierre de caja
-- muestra plata que nadie cobró.
--
-- Con el identificador, el reintento reconoce la que ya entró y devuelve esa.
alter table invoices add column if not exists offline_id text;

-- Único POR NEGOCIO: dos negocios pueden generar el mismo id local sin chocar.
create unique index if not exists invoices_offline_id_key
  on invoices (tenant_id, offline_id)
  where offline_id is not null;
