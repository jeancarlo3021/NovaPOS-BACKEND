-- Agrega el rol 'repartidor' a la restricción CHECK de users.role.
-- (El enum de la app ya lo permite; la base lo rechazaba con users_role_check.)

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
  role IN (
    'owner', 'admin', 'gerente',
    'asistente_1', 'asistente_2', 'asistente_3',
    'cocinero', 'mesero', 'cajero', 'almacenero', 'contador', 'repartidor'
  )
);

-- Por si la tabla user_tenants también tiene una restricción de rol.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_tenants') THEN
    BEGIN
      ALTER TABLE user_tenants DROP CONSTRAINT IF EXISTS user_tenants_role_check;
      ALTER TABLE user_tenants ADD CONSTRAINT user_tenants_role_check CHECK (
        role IN (
          'owner', 'admin', 'gerente',
          'asistente_1', 'asistente_2', 'asistente_3',
          'cocinero', 'mesero', 'cajero', 'almacenero', 'contador', 'repartidor'
        )
      );
    EXCEPTION WHEN undefined_column THEN
      -- user_tenants no tiene columna role; nada que hacer.
      NULL;
    END;
  END IF;
END $$;
