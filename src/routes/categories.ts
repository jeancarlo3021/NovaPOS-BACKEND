import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const categories = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const CategorySchema = z.object({
  name:        z.string().min(1),
  description: z.string().optional().nullable(),
  color:       z.string().optional().nullable(),
  icon:        z.string().optional().nullable(),
});

// products.category_id → product_categories.id
const TABLE = 'product_categories';

categories.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from(TABLE).select('*').eq('tenant_id', tenantId).order('name');
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

categories.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = CategorySchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const { data, error } = await db.from(TABLE).insert({ ...parsed.data, tenant_id: tenantId }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

categories.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const parsed = CategorySchema.partial().safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const { data, error } = await db.from(TABLE).update(parsed.data).eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Categoría no encontrada', 404);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

categories.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db.from(TABLE).delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default categories;
