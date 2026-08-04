-- Tipo de grupo de empresas.
--
-- El mecanismo de grupos ya servía para dos cosas distintas que se veían igual:
--   · 'branches'   — SUCURSALES de un mismo negocio (se suman ventas, cuota por
--                    sucursal, inventario compartido).
--   · 'accounting' — CARTERA DE UN CONTADOR: empresas de clientes distintos que
--                    él lleva. NO se suman entre sí ni comparten nada; solo
--                    comparten a quién les configura la factura electrónica.
--
-- Sin esta distinción, la cartera de un contador aparecía como "sucursales" y sus
-- ventas se sumaban en la cuota del grupo, que es exactamente lo que no debe pasar.
ALTER TABLE tenant_groups
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'branches';
