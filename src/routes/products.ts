import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const products = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const ProductSchema = z.object({
  name:            z.string().min(1),
  sku:             z.string().optional().default(''),
  description:     z.string().optional().nullable(),
  unit_price:      z.number().nonnegative().optional().nullable(),
  cost_price:      z.number().nonnegative().optional().nullable(),
  stock_quantity:  z.number().int().nonnegative().optional().default(0),
  min_stock_level: z.number().int().nonnegative().optional().default(0),
  max_stock_level: z.number().int().nonnegative().optional().default(100),
  category_id:     z.string().uuid().optional().nullable(),
  unit_type_id:    z.string().uuid().optional().nullable(),
  image_url:       z.string().url().optional().nullable(),
  tracks_stock:    z.boolean().optional(),
  cabys_code:      z.string().optional().nullable(),
  iva_rate:        z.number().nonnegative().max(100).optional().nullable(),
});

products.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const search   = c.req.query('search');
    const category = c.req.query('category');

    let query = db.from('products').select('*').eq('tenant_id', tenantId).order('name');
    if (search)   query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);
    if (category) query = query.eq('category_id', category);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

products.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data, error } = await db.from('products').select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Producto no encontrado', 404);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

products.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = ProductSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db.from('products')
      .insert({
        ...parsed.data,
        // Default solo al CREAR: si no se especifica, rastrea stock.
        tracks_stock: parsed.data.tracks_stock ?? true,
        tenant_id: tenantId,
      })
      .select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

products.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const parsed = ProductSchema.partial().safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db.from('products')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId)
      .select().single();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Producto no encontrado', 404);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

products.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db.from('products').delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default products;
