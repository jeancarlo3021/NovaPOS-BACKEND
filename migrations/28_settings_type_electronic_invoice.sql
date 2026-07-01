-- El CHECK settings_type_check rechazaba 'electronic-invoice', impidiendo guardar
-- la config de FE. Lo recreamos incluyendo TODOS los tipos: los existentes en la
-- base + los que usa la app.

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_type_check;

ALTER TABLE settings ADD CONSTRAINT settings_type_check CHECK (
  type IN (
    'general',
    'receipt',
    'products',
    'users',
    'notifications',
    'payments',
    'electronic-invoice',
    'pos-kiosk',
    'pages'
  )
);
