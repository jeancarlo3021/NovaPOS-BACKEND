-- Una factura EMITIDA a Hacienda no se borra. Nunca.
--
-- ── Qué pasó ───────────────────────────────────────────────────────────────
-- Se borraron a mano, desde la consola de la base, facturas que ya tenían clave
-- de Hacienda. El comprobante siguió existiendo en Hacienda —eso no se deshace—
-- pero desapareció del sistema: dejó de salir en reportes, en el cierre y en la
-- declaración, y su número quedó como un hueco imposible de explicar. Rastrear
-- una sola de esas facturas llevó horas, y solo se descubrió por el hueco en la
-- numeración.
--
-- ── Por qué a nivel de BASE y no de aplicación ─────────────────────────────
-- Porque el borrado NO vino de la aplicación: vino de la consola. Una validación
-- en el código no habría cambiado nada. Esto protege por igual a la app, a la
-- consola y a cualquier script.
--
-- ── Qué se sigue pudiendo hacer ────────────────────────────────────────────
--  · ANULAR una factura (status = 'cancelled') — sigue permitido y es lo
--    correcto: la venta queda registrada como anulada, no desaparece.
--  · Emitir una NOTA DE CRÉDITO, que es lo que Hacienda reconoce para dejar sin
--    efecto un comprobante.
--  · Borrar facturas SIN emitir (sin clave): un tiquete corriente o una venta
--    que nunca llegó a Hacienda no le debe nada a nadie.
--  · Borrar un negocio completo: eso pasa por `delete_tenant_cascade`, que
--    desactiva la protección a propósito (ver abajo).

create or replace function public.impedir_borrar_factura_emitida()
returns trigger
language plpgsql
as $$
begin
  -- Válvula para el borrado de un negocio entero, que sí debe poder limpiar todo.
  -- Se activa con: set local app.borrado_masivo = 'on';
  if coalesce(current_setting('app.borrado_masivo', true), '') = 'on' then
    return old;
  end if;

  if old.fe_clave is not null then
    raise exception
      'No se puede borrar la factura % : ya fue emitida a Hacienda (clave %). '
      'Hacienda la tiene igual, así que borrarla solo la esconde del sistema. '
      'Para dejarla sin efecto, anulala o emitile una nota de crédito.',
      coalesce(old.invoice_number, old.id::text), old.fe_clave
      using errcode = 'restrict_violation';
  end if;

  return old;
end;
$$;

drop trigger if exists trg_impedir_borrar_factura_emitida on public.invoices;
create trigger trg_impedir_borrar_factura_emitida
  before delete on public.invoices
  for each row
  execute function public.impedir_borrar_factura_emitida();

-- ── Borrado de un negocio completo ─────────────────────────────────────────
-- El backend borra un tenant con varios DELETE seguidos. Para que siga
-- funcionando, esa operación tiene que abrir la válvula antes de empezar:
--
--   select public.permitir_borrado_masivo();
--
-- Dura lo que dure la transacción/sesión, así que no queda abierta por descuido.
create or replace function public.permitir_borrado_masivo()
returns void
language sql
as $$ select set_config('app.borrado_masivo', 'on', true) $$;
