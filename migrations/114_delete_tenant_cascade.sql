-- Borrar un negocio completo, de verdad y en UNA sola transacción.
--
-- ── Qué pasaba ─────────────────────────────────────────────────────────────
-- El backend borraba el negocio con una serie de DELETE, cada uno en su propia
-- transacción, y antes llamaba a `permitir_borrado_masivo()` para abrir la
-- válvula de la migración 109 (la que impide borrar facturas ya emitidas a
-- Hacienda). Pero esa válvula se abre con `set_config(..., true)`: vale SOLO
-- dentro de la transacción. Para cuando llegaba el turno de las facturas, ya
-- estaba cerrada, la factura emitida se quedaba, el negocio conservaba datos
-- colgando y tampoco se podía borrar. El panel respondía «eliminado» igual
-- porque no miraba el resultado: el negocio volvía a aparecer siempre.
--
-- ── Cómo se arregla ────────────────────────────────────────────────────────
-- Todo el borrado pasa a ser UNA función: abre la válvula y limpia dentro de la
-- misma transacción. Si algo falla, no queda un negocio borrado a medias.
--
-- Primero las tablas hijas que cuelgan de otra fila (no del negocio) y después,
-- en varias pasadas, toda tabla que tenga `tenant_id`. Las pasadas resuelven el
-- orden de dependencias sin mantener una lista a mano: lo que no se puede
-- limpiar en una vuelta se limpia en la siguiente.
create or replace function public.delete_tenant_cascade(p_tenant uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tabla    record;
  v_pasada   int;
  v_quedan   int;
  v_limpias  text[] := '{}';
begin
  if p_tenant is null then
    raise exception 'Falta el negocio a borrar';
  end if;
  if not exists (select 1 from public.tenants where id = p_tenant) then
    return jsonb_build_object('ok', true, 'ya_no_existia', true);
  end if;

  -- La válvula de la migración 109, en la MISMA transacción que la limpieza.
  perform set_config('app.borrado_masivo', 'on', true);

  -- Hijas que no cuelgan del negocio sino de otra fila suya.
  if to_regclass('public.invoice_items') is not null then
    delete from public.invoice_items
     where invoice_id in (select id from public.invoices where tenant_id = p_tenant);
  end if;
  if to_regclass('public.reservation_payments') is not null then
    delete from public.reservation_payments
     where reservation_id in (select id from public.reservations where tenant_id = p_tenant);
  end if;
  if to_regclass('public.reservation_items') is not null then
    delete from public.reservation_items
     where reservation_id in (select id from public.reservations where tenant_id = p_tenant);
  end if;
  if to_regclass('public.purchase_items') is not null then
    delete from public.purchase_items
     where purchase_id in (select id from public.purchases where tenant_id = p_tenant);
  end if;
  if to_regclass('public.warehouse_stock') is not null then
    delete from public.warehouse_stock
     where warehouse_id in (select id from public.warehouses where tenant_id = p_tenant);
  end if;

  -- Todo lo que tenga `tenant_id`, en varias pasadas.
  for v_pasada in 1..6 loop
    for v_tabla in
      select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join information_schema.columns col
          on col.table_schema = 'public'
         and col.table_name = c.relname
         and col.column_name = 'tenant_id'
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relname <> 'tenants'
    loop
      begin
        execute format('delete from public.%I where tenant_id = $1', v_tabla.relname) using p_tenant;
        if found and not (v_tabla.relname = any(v_limpias)) then
          v_limpias := array_append(v_limpias, v_tabla.relname);
        end if;
      exception when others then
        -- Todavía hay algo apuntando a esas filas: se reintenta en la próxima pasada.
        null;
      end;
    end loop;
  end loop;

  delete from public.tenants where id = p_tenant;

  select count(*) into v_quedan from public.tenants where id = p_tenant;
  if v_quedan > 0 then
    raise exception 'No se pudo borrar el negocio: todavía hay datos que dependen de él';
  end if;

  return jsonb_build_object('ok', true, 'tablas', to_jsonb(v_limpias));
end;
$$;

revoke all on function public.delete_tenant_cascade(uuid) from public, anon, authenticated;
