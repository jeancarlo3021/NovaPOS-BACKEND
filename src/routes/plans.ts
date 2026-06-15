import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const plans = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// GET / — list all subscription plans
plans.get('/', async (c) => {
  try {
    const { data, error } = await db
      .from('subscription_plans')
      .select('*')
      .order('price', { ascending: true });

    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /current — current tenant subscription with plan details
plans.get('/current', async (c) => {
  try {
    const tenantId = c.get('tenantId');

    const { data, error } = await db
      .from('subscriptions')
      .select('*, subscription_plans(*)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /:id — single plan
plans.get('/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const { data, error } = await db
      .from('subscription_plans')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Plan no encontrado', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — crear nuevo plan (solo super-admin)
plans.post('/', async (c) => {
  try {
    const body = await c.req.json();

    const name = String(body.name ?? '').trim();
    if (!name) return fail(c, 'name es requerido', 400);

    const row = {
      name,
      description:    body.description ?? '',
      price:          Number(body.price ?? 0),
      billing_cycle:  body.billing_cycle ?? 'monthly',
      max_users:      body.max_users ?? null,
      max_products:   body.max_products ?? null,
      max_orders:     body.max_orders ?? null,
      features:       body.features ?? {},
      is_active:      body.is_active ?? true,
    };

    const { data, error } = await db
      .from('subscription_plans')
      .insert(row)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /:id — eliminar plan
plans.delete('/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const { error } = await db.from('subscription_plans').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /:id — update plan
plans.put('/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();

    const { data, error } = await db
      .from('subscription_plans')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default plans;
