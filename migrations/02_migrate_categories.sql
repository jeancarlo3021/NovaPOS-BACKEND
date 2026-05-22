-- Migrate category data from 'categories' table to 'product_categories'
-- This is a one-time migration to fix the foreign key constraint
-- product_categories should already exist with the same schema as categories

INSERT INTO product_categories (id, tenant_id, name, description, color, icon, created_at, updated_at)
SELECT
  id,
  tenant_id,
  name,
  COALESCE(description, ''),
  COALESCE(color, '#3B82F6'),
  COALESCE(icon, ''),
  created_at,
  NOW()
FROM categories
WHERE id NOT IN (SELECT id FROM product_categories)
ON CONFLICT (id) DO NOTHING;

-- Verify migration
SELECT COUNT(*) as categories_count FROM categories;
SELECT COUNT(*) as product_categories_count FROM product_categories;
