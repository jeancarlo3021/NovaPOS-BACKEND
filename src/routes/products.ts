import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const products = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const ProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  price: z.number().positive(),
  cost: z.number().nonnegative().optional(),
  stock: z.number().int().nonnegative().optional(),
  min_stock: z.number().int().nonnegative().optional(),
  category_id: z.string().uuid().optional().nullable(),
  unit_type_id: z.string().uuid().optional().nullable(),
  barcode: z.string().optional().nullable(),
  image_url: z.string().url().optional().nullable(),
  is_active: z.boolean().optional(),
});

// GET / — list products (supports ?search=, ?category=)
products.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const search = c.req.query('search');
    const category = c.req.query('category');

    let query = db
      .from('products')
      .select('*, categories(name), unit_types(name)')
      .eq('tenant_id', tenantId)
      .order('name');

    if (search) {
      query = query.or(`name.ilike.%${search}%,barcode.ilike.%${search}%`);
    }
    if (category) {
      query = query.eq('category_id', category);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /:id — single product
products.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data, error } = await db
      .from('products')
      .select('*, categories(name), unit_types(name)')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Producto no encontrado', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — create product
products.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const parsed = ProductSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('products')
      .insert({ ...parsed.data, tenant_id: tenantId })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /:id — update product
products.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = ProductSchema.partial().safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('products')
      .update(parsed.data)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Producto no encontrado', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /:id — delete product
products.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { error } = await db
      .from('products')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default products;
