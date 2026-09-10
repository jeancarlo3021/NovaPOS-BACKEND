-- EXISTENCIAS APARTADAS ("standby").
--
-- Hasta ahora, apartar mercadería la RESTABA de `stock_quantity`. El número
-- cuadraba para vender —no se puede vender lo apartado— pero mentía sobre la
-- bodega: el producto seguía físicamente en el local y el sistema decía que no
-- estaba. Al contar el inventario nunca cuadraba, y nadie podía explicar por qué
-- había bajado.
--
-- Ahora se separan las dos cosas:
--   stock_quantity     = lo que hay FÍSICAMENTE (no cambia al apartar)
--   reserved_quantity  = cuánto de eso está apartado con nombre de cliente
--   disponible         = stock_quantity - reserved_quantity  ← lo vendible
alter table public.products
  add column if not exists reserved_quantity numeric(14,3) not null default 0;

comment on column public.products.reserved_quantity is
  'Cantidad apartada por clientes (apartados vigentes). Está en bodega pero no se puede vender.';

-- ── Corrección de los apartados que YA existen ──────────────────────────────
-- A ellos se les restó el stock con el criterio viejo. Se les devuelve la
-- existencia y se registra como apartada, para que el inventario refleje lo que
-- de verdad hay en el local.
with apartado as (
  select ri.product_id, sum(ri.quantity) as cant
  from reservation_items ri
  join reservations r on r.id = ri.reservation_id
  where r.status = 'open' and ri.product_id is not null
  group by ri.product_id
)
update public.products p
   set stock_quantity    = coalesce(p.stock_quantity, 0) + a.cant,
       reserved_quantity = a.cant
  from apartado a
 where p.id = a.product_id
   and coalesce(p.reserved_quantity, 0) = 0;   -- solo una vez

-- Lo disponible para vender, listo para consultar sin repetir la resta.
create or replace view public.products_disponibles as
  select p.*,
         coalesce(p.stock_quantity, 0) - coalesce(p.reserved_quantity, 0) as available_quantity
    from public.products p;
