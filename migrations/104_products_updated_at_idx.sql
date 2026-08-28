-- El catálogo se sincroniza por cambios, no entero.
--
-- El POS pregunta «¿qué cambió desde tal fecha?» en cada arranque. Sin índice,
-- esa consulta recorre todos los productos del negocio para descubrir que no
-- cambió ninguno, que es justamente el caso normal.
create index if not exists idx_products_tenant_updated
  on products (tenant_id, updated_at);

-- Sin fecha de modificación, un producto viejo nunca viajaría en una
-- sincronización incremental: quedaría invisible para los aparatos que ya
-- tienen catálogo guardado. Se les pone la de creación.
update products set updated_at = coalesce(updated_at, created_at, now())
where updated_at is null;
