import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const invoices = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const InvoiceItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().positive(),
  unit_price: z.number().nonnegative(),
  discount: z.number().nonnegative().optional().default(0),
  tax_rate: z.number().nonnegative().optional().default(0),
  total_price: z.number().nonnegative().optional(),
});

const InvoiceSchema = z.object({
  customer_name: z.string().optional().nullable(),
  customer_email: z.string().email().optional().nullable(),
  customer_tax_id: z.string().optional().nullable(),
  payment_method: z.string().optional().default('cash'),
  cash_session_id: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
  discount: z.number().nonnegative().optional().default(0),
  tax_amount: z.number().nonnegative().optional().default(0),
  items: z.array(InvoiceItemSchema).min(1),
});

// GET / — list invoices (?from=, ?to=, ?page=, ?limit=)
invoices.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const page = Number(c.req.query('page') ?? 1);
    const limit = Number(c.req.query('limit') ?? 50);
    const offset = (page - 1) * limit;

    let query = db
      .from('invoices')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    return ok(c, { invoices: data, total: count, page, limit });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /:id — single invoice with items
invoices.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data, error } = await db
      .from('invoices')
      .select('*, invoice_items(*, products(name, barcode))')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Factura no encontrada', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — create invoice + items, decrement stock
invoices.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json();
    const parsed = InvoiceSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { items, ...invoiceData } = parsed.data;

    // Calculate subtotal and total
    const subtotal = items.reduce((sum, item) => {
      const lineTotal = item.unit_price * item.quantity - (item.discount ?? 0);
      return sum + lineTotal;
    }, 0);
    const total = subtotal + (invoiceData.tax_amount ?? 0) - (invoiceData.discount ?? 0);

    // Insert invoice
    const { data: invoice, error: invoiceError } = await db
      .from('invoices')
      .insert({
        ...invoiceData,
        tenant_id: tenantId,
        created_by: userId,
        subtotal,
        total_amount: total,
        status: 'paid',
      })
      .select()
      .single();

    if (invoiceError) throw new Error(invoiceError.message);

    // Insert invoice items
    const itemsToInsert = items.map((item) => ({
      ...item,
      invoice_id: invoice.id,
      total_price: item.total_price ?? item.unit_price * item.quantity - (item.discount ?? 0),
    }));

    const { error: itemsError } = await db.from('invoice_items').insert(itemsToInsert);
    if (itemsError) throw new Error(itemsError.message);

    // Decrement stock for each item
    for (const item of items) {
      const { data: product } = await db
        .from('products')
        .select('stock')
        .eq('id', item.product_id)
        .maybeSingle();

      if (product) {
        const newStock = Math.max(0, (product.stock ?? 0) - item.quantity);
        await db
          .from('products')
          .update({ stock: newStock })
          .eq('id', item.product_id);
      }
    }

    return ok(c, { ...invoice, items: itemsToInsert }, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /:id/void — void an invoice
invoices.post('/:id/void', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data, error } = await db
      .from('invoices')
      .update({ status: 'voided', voided_at: new Date().toISOString() })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Factura no encontrada', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default invoices;
