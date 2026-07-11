-- El CHECK settings_type_check limitaba los `type` de settings a una lista fija,
-- y bloqueaba tipos válidos de la app (rompió con 'electronic-invoice' y ahora con
-- 'feature-overrides' → los módulos personalizados no se guardaban).
-- El `type` lo controla la app (no es entrada de usuario), así que la validación por
-- lista sólo genera bugs. Lo eliminamos.
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_type_check;
