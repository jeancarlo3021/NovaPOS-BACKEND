import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

// Precios especiales por cliente. Ver migrations/16_customer_prices.sql
const customerPrices = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const UpsertSchema = z.object({
  customer_id: z.string().uuid(),
  product_id:  z.string().uuid(),
  price:       z.number().nonnegative(),
});

// GET /?customer_id=  → lista los precios especiales de un cliente.
// Sin customer_id → todos los del tenant (para administración).
customerPrices.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const customerId = c.req.query('customer_id');
    let q = db.from('customer_prices').select('*').eq('tenant_id', tenantId);
    if (customerId) q = q.eq('customer_id', customerId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /  → upsert (crea o actualiza) el precio de un producto para un cliente.
customerPrices.put('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = UpsertSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const { customer_id, product_id, price } = parsed.data;
    const { data, error } = await db.from('customer_prices')
      .upsert({ tenant_id: tenantId, customer_id, product_id, price, updated_at: new Date().toISOString() },
              { onConflict: 'customer_id,product_id' })
      .select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// DELETE /?customer_id=&product_id=  → quita el precio especial (vuelve al normal).
customerPrices.delete('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const customerId = c.req.query('customer_id');
    const productId  = c.req.query('product_id');
    if (!customerId || !productId) return fail(c, 'customer_id y product_id requeridos', 422);
    const { error } = await db.from('customer_prices')
      .delete().eq('tenant_id', tenantId).eq('customer_id', customerId).eq('product_id', productId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default customerPrices;
