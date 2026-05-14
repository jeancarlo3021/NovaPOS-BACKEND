import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const purchases = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const PurchaseItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().positive(),
  unit_cost: z.number().nonnegative(),
  total_cost: z.number().nonnegative().optional(),
});

const PurchaseSchema = z.object({
  supplier_id: z.string().uuid().optional().nullable(),
  reference_number: z.string().optional().nullable(),
  purchase_date: z.string().optional(),
  expected_date: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  status: z.enum(['pending', 'received', 'partial', 'cancelled']).optional(),
  items: z.array(PurchaseItemSchema).min(1),
});

// GET / — list purchases (supports ?status=)
purchases.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status');

    let query = db
      .from('purchases')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /:id — single purchase with items
purchases.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data, error } = await db
      .from('purchases')
      .select('*, purchase_items(*)')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Compra no encontrada', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — create purchase with items
purchases.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json();
    const parsed = PurchaseSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { items, ...purchaseData } = parsed.data;

    // Calculate total
    const total = items.reduce((sum, item) => sum + item.unit_cost * item.quantity, 0);

    const { data: purchase, error: purchaseError } = await db
      .from('purchases')
      .insert({
        ...purchaseData,
        tenant_id: tenantId,
        created_by: userId,
        total_amount: total,
        status: purchaseData.status ?? 'pending',
      })
      .select()
      .single();

    if (purchaseError) throw new Error(purchaseError.message);

    const itemsToInsert = items.map((item) => ({
      ...item,
      purchase_id: purchase.id,
      total_cost: item.total_cost ?? item.unit_cost * item.quantity,
    }));

    const { error: itemsError } = await db.from('purchase_items').insert(itemsToInsert);
    if (itemsError) throw new Error(itemsError.message);

    return ok(c, { ...purchase, items: itemsToInsert }, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /:id — update purchase
purchases.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = PurchaseSchema.omit({ items: true }).partial().safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('purchases')
      .update(parsed.data)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Compra no encontrada', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /:id/receive — mark as received and update stock
purchases.post('/:id/receive', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    // Fetch purchase and its items
    const { data: purchase, error: fetchError } = await db
      .from('purchases')
      .select('*, purchase_items(*)')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (fetchError) throw new Error(fetchError.message);
    if (!purchase) return fail(c, 'Compra no encontrada', 404);
    if (purchase.status === 'received') return fail(c, 'La compra ya fue recibida', 400);
    if (purchase.status === 'cancelled') return fail(c, 'La compra está cancelada', 400);

    // Update purchase status
    const { error: updateError } = await db
      .from('purchases')
      .update({ status: 'received', received_at: new Date().toISOString() })
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (updateError) throw new Error(updateError.message);

    // Increment stock for each item
    for (const item of purchase.purchase_items) {
      const { data: product } = await db
        .from('products')
        .select('stock')
        .eq('id', item.product_id)
        .maybeSingle();

      if (product) {
        const newStock = (product.stock ?? 0) + item.quantity;
        await db
          .from('products')
          .update({ stock: newStock })
          .eq('id', item.product_id);
      }
    }

    return ok(c, { received: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /:id — cancel purchase
purchases.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data, error } = await db
      .from('purchases')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Compra no encontrada', 404);
    return ok(c, { cancelled: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default purchases;
