-- Precio de venta personalizado por negocio (override del precio del plan).
-- Si custom_price es NULL, se usa el precio del plan (subscription_plans.price).
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS custom_price NUMERIC;
