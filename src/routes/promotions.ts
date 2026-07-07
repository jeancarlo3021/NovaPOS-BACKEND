import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const promotions = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const PromotionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  type: z.enum(['percentage', 'fixed', 'bogo', 'bundle', '2x1', 'combo']).optional().default('percentage'),
  value: z.number().nonnegative(),
  // Combo/bundle: 'price' = precio fijo del combo · 'percent' = % de descuento sobre el combo.
  combo_mode: z.enum(['price', 'percent']).optional().nullable(),
  min_purchase: z.number().nonnegative().optional().nullable(),
  applies_to: z.enum(['all', 'category', 'products']).optional().default('all'),
  category_id: z.string().uuid().optional().nullable(),
  product_ids: z.array(z.string().uuid()).optional().nullable(),
  starts_at: z.string().optional(),
  ends_at: z.string().optional().nullable(),
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
    const today = new Date().toISOString().slice(0, 10);

    let query = db
      .from('promotions')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('name');

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const active = (data ?? []).filter(p =>
      (!p.starts_at || p.starts_at <= today) &&
      (!p.ends_at || p.ends_at >= today)
    );

    return ok(c, active);
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

    const today = new Date().toISOString().slice(0, 10);
    const payload = {
      tenant_id: tenantId,
      name: parsed.data.name,
      description: parsed.data.description || null,
      type: parsed.data.type || 'percentage',
      value: parsed.data.value,
      combo_mode: parsed.data.combo_mode ?? null,
      min_purchase: parsed.data.min_purchase || null,
      applies_to: parsed.data.applies_to || 'all',
      category_id: parsed.data.category_id || null,
      product_ids: parsed.data.product_ids || null,
      starts_at: parsed.data.starts_at || today,
      ends_at: parsed.data.ends_at || null,
      is_active: parsed.data.is_active !== undefined ? parsed.data.is_active : true,
    };

    console.log('[PROMOTION] Creating:', payload);
    const { data, error } = await db
      .from('promotions')
      .insert(payload)
      .select()
      .single();

    if (error) {
      console.error('[PROMOTION] Insert error:', error);
      throw new Error(error.message);
    }
    console.log('[PROMOTION] Created successfully:', data?.id);
    return ok(c, data, 201);
  } catch (err: any) {
    console.error('[PROMOTION] Catch error:', err.message);
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
