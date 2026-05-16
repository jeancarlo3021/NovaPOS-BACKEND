import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const invoices = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const ItemSchema = z.object({
  product_id:       z.string().uuid(),
  quantity:         z.number().positive(),
  unit_price:       z.number().nonnegative(),
  discount_percent: z.number().nonnegative().optional().default(0),
  discount_amount:  z.number().nonnegative().optional().default(0),
  subtotal:         z.number().nonnegative(),
});

const InvoiceSchema = z.object({
  cash_session_id:  z.string().uuid(),
  customer_id:      z.string().uuid().optional().nullable(),
  invoice_number:   z.string().min(1),
  customer_name:    z.string().optional().nullable(),
  customer_email:   z.string().optional().nullable(),
  customer_phone:   z.string().optional().nullable(),
  subtotal:         z.number().nonnegative(),
  discount_amount:  z.number().nonnegative().optional().default(0),
  discount_percent: z.number().nonnegative().optional().default(0),
  tax_percent:      z.number().nonnegative().optional().default(13),
  tax_amount:       z.number().nonnegative(),
  total:            z.number().nonnegative(),
  payment_method:   z.enum(['cash', 'card', 'sinpe', 'check', 'transfer']).default('cash'),
  status:           z.enum(['draft', 'completed', 'cancelled']).default('completed'),
  notes:            z.string().optional().nullable(),
  issued_at:        z.string().optional(),
  amount_received:  z.number().optional().nullable(),
  change_amount:    z.number().optional().nullable(),
  voucher_number:   z.string().optional().nullable(),
  items:            z.array(ItemSchema).min(1),
});

invoices.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from  = c.req.query('from');
    const to    = c.req.query('to');
    const page  = Number(c.req.query('page') ?? 1);
    const limit = Number(c.req.query('limit') ?? 50);

    let query = db.from('invoices').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('issued_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    if (from) query = query.gte('issued_at', from);
    if (to)   query = query.lte('issued_at', to);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    return ok(c, { invoices: data, total: count, page, limit });
  } catch (err: any) { return fail(c, err.message, 500); }
});

invoices.get('/next-number', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { count } = await db.from('invoices').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId);
    const next = String((count ?? 0) + 1).padStart(6, '0');
    return ok(c, { invoice_number: `INV-${next}` });
  } catch (err: any) { return fail(c, err.message, 500); }
});

invoices.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data, error } = await db.from('invoices').select('*, invoice_items(*)')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Factura no encontrada', 404);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

invoices.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = InvoiceSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { items, ...invoiceData } = parsed.data;

    const { data: inv, error: invErr } = await db.from('invoices')
      .insert({ ...invoiceData, tenant_id: tenantId, issued_at: invoiceData.issued_at ?? new Date().toISOString() })
      .select().single();
    if (invErr) throw new Error(invErr.message);

    const itemRows = items.map(item => ({ ...item, invoice_id: inv.id }));
    const { error: itemErr } = await db.from('invoice_items').insert(itemRows);
    if (itemErr) throw new Error(itemErr.message);

    // Decrement stock
    for (const item of items) {
      await db.from('products').select('stock_quantity').eq('id', item.product_id).single()
        .then(async ({ data: p }) => {
          if (p) await db.from('products').update({
            stock_quantity: Math.max(0, (p.stock_quantity ?? 0) - item.quantity),
          }).eq('id', item.product_id);
        });
    }

    return ok(c, inv, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

invoices.post('/:id/void', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data, error } = await db.from('invoices')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default invoices;
