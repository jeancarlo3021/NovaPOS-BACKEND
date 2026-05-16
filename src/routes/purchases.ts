import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const purchases = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const ItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity:   z.number().positive(),
  unit_price: z.number().nonnegative().optional().nullable(),
  subtotal:   z.number().nonnegative().optional().nullable(),
});

const PurchaseSchema = z.object({
  supplier_id:            z.string().uuid(),
  purchase_number:        z.string().min(1),
  purchase_date:          z.string(),
  expected_delivery_date: z.string().optional().nullable(),
  notes:                  z.string().optional().nullable(),
  total_amount:           z.number().nonnegative().optional().nullable(),
  items:                  z.array(ItemSchema).min(1),
});

purchases.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status   = c.req.query('status');

    let query = db.from('purchases').select('*').eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

purchases.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const { data, error } = await db.from('purchases').select('*, purchase_items(*)')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Compra no encontrada', 404);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

purchases.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = PurchaseSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { items, ...purchaseData } = parsed.data;
    const { data: purchase, error: pErr } = await db.from('purchases')
      .insert({ ...purchaseData, tenant_id: tenantId, status: 'pending' }).select().single();
    if (pErr) throw new Error(pErr.message);

    const itemRows = items.map(item => ({ ...item, purchase_id: purchase.id }));
    const { error: iErr } = await db.from('purchase_items').insert(itemRows);
    if (iErr) throw new Error(iErr.message);

    return ok(c, purchase, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

purchases.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const body     = await c.req.json();
    const { data, error } = await db.from('purchases')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/receive — mark as received, increment stock
purchases.post('/:id/receive', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const { items } = await c.req.json() as { items: { product_id: string; quantity: number }[] };

    const { data, error } = await db.from('purchases')
      .update({ status: 'received', actual_delivery_date: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);

    // Increment stock for each received item
    for (const item of (items ?? [])) {
      const { data: p } = await db.from('products').select('stock_quantity').eq('id', item.product_id).single();
      if (p) await db.from('products').update({
        stock_quantity: (p.stock_quantity ?? 0) + item.quantity,
        updated_at: new Date().toISOString(),
      }).eq('id', item.product_id);
    }

    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

purchases.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const { data, error } = await db.from('purchases')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default purchases;
