import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const promotions = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const PromotionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  type: z.enum(['percentage', 'fixed', 'bogo', 'bundle']).optional().default('percentage'),
  value: z.number().nonnegative(),
  min_purchase: z.number().nonnegative().optional().nullable(),
  product_ids: z.array(z.string().uuid()).optional().nullable(),
  category_ids: z.array(z.string().uuid()).optional().nullable(),
  start_date: z.string().optional().nullable(),
  end_date: z.string().optional().nullable(),
  is_active: z.boolean().optional().default(true),
});

// GET / — list all promotions
promotions.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db
      .from('promotions')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /active — active promotions for today
promotions.get('/active', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const today = new Date().toISOString();

    const { data, error } = await db
      .from('promotions')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .or(`start_date.is.null,start_date.lte.${today}`)
      .or(`end_date.is.null,end_date.gte.${today}`)
      .order('name');

    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — create promotion
promotions.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const parsed = PromotionSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('promotions')
      .insert({ ...parsed.data, tenant_id: tenantId })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /:id — update promotion
promotions.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = PromotionSchema.partial().safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('promotions')
      .update(parsed.data)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Promoción no encontrada', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /:id — delete promotion
promotions.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { error } = await db
      .from('promotions')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PATCH /:id/toggle — toggle is_active
promotions.patch('/:id/toggle', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    // Fetch current state
    const { data: current, error: fetchError } = await db
      .from('promotions')
      .select('is_active')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (fetchError) throw new Error(fetchError.message);
    if (!current) return fail(c, 'Promoción no encontrada', 404);

    const { data, error } = await db
      .from('promotions')
      .update({ is_active: !current.is_active })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default promotions;
