import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const tenants = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// GET /me — current tenant with subscription info
tenants.get('/me', async (c) => {
  try {
    const tenantId = c.get('tenantId');

    const { data, error } = await db
      .from('tenants')
      .select(
        `*,
        tenant_subscriptions(
          id,
          status,
          started_at,
          expires_at,
          subscription_plans(id, name, price, features)
        )`
      )
      .eq('id', tenantId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Tenant no encontrado', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default tenants;
