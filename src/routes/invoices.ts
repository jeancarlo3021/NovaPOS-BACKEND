import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const invoices = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// CartItem from frontend has extra fields (product, promo) — accept any object with product_id
const ItemSchema = z.object({
  product_id:       z.string().uuid(),
  quantity:         z.number().positive(),
  unit_price:       z.number().nonnegative(),
  discount_percent: z.number().nonnegative().optional().default(0),
  discount_amount:  z.number().nonnegative().optional().default(0),
  subtotal:         z.number().nonnegative(),
}).passthrough(); // ignore extra fields like 'product', 'promo'

const InvoiceSchema = z.object({
  cash_session_id:  z.string().uuid(),
  customer_id:      z.string().uuid().optional().nullable(),
  invoice_number:   z.string().optional().nullable(), // auto-generated if absent
  customer_name:    z.string().optional().nullable(),
  customer_email:   z.string().optional().nullable(),
  customer_phone:   z.string().optional().nullable(),
  subtotal:         z.number().nonnegative(),
  discount_amount:  z.number().nonnegative().optional().default(0),
  discount_percent: z.number().nonnegative().optional().default(0),
  tax_percent:      z.number().nonnegative().optional().default(13),
  tax_amount:       z.number().nonnegative().default(0),
  total:            z.number().nonnegative(),
  payment_method:   z.enum(['cash', 'card', 'sinpe', 'check', 'transfer']).default('cash'),
  status:           z.enum(['draft', 'completed', 'cancelled']).default('completed'),
  notes:            z.string().optional().nullable(),
  issued_at:        z.string().optional().nullable(),
  amount_received:  z.number().optional().nullable(),
  change_amount:    z.number().optional().nullable(),
  voucher_number:   z.string().optional().nullable(),
  items:            z.array(ItemSchema).min(1),
});

// Auto-generate invoice number - same format as offline
async function nextInvoiceNumber(tenantId: string): Promise<string> {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');

  // Count invoices created today
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  const { count } = await db.from('invoices')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', todayStart)
    .lt('created_at', todayEnd);

  return `${datePart}-${String((count ?? 0) + 1).padStart(5, '0')}`;
}

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
    const num = await nextInvoiceNumber(c.get('tenantId'));
    return ok(c, { invoice_number: num });
  } catch (err: any) { return fail(c, err.message, 500); }
});

invoices.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data, error } = await db.from('invoices').select('*, invoice_items(*)')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(typeof error === 'string' ? error : (error as any).message || JSON.stringify(error));
    if (!data) return fail(c, 'Factura no encontrada', 404);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

invoices.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const raw = await c.req.json();
    const parsed = InvoiceSchema.safeParse(raw);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { items, invoice_number, ...invoiceData } = parsed.data;

    // Auto-generate invoice_number if not provided
    const finalNumber = (invoice_number?.trim()) || await nextInvoiceNumber(tenantId);

    const { data: inv, error: invErr } = await db.from('invoices').insert({
      ...invoiceData,
      tenant_id:      tenantId,
      invoice_number: finalNumber,
      issued_at:      invoiceData.issued_at ?? new Date().toISOString(),
    }).select().single();
    if (invErr) throw new Error(invErr.message);

    // Insert items (strip extra CartItem fields)
    const itemRows = items.map((item: any) => ({
      invoice_id:       inv.id,
      product_id:       item.product_id,
      quantity:         item.quantity,
      unit_price:       item.unit_price,
      discount_percent: item.discount_percent ?? 0,
      discount_amount:  item.discount_amount ?? 0,
      subtotal:         item.subtotal,
    }));
    const { error: itemErr } = await db.from('invoice_items').insert(itemRows);
    if (itemErr) throw new Error(itemErr.message);

    // Decrement stock
    for (const item of items as any[]) {
      const { data: p } = await db.from('products')
        .select('stock_quantity').eq('id', item.product_id).maybeSingle();
      if (p) {
        await db.from('products').update({
          stock_quantity: Math.max(0, (p.stock_quantity ?? 0) - Number(item.quantity)),
          updated_at: new Date().toISOString(),
        }).eq('id', item.product_id);
      }
    }

    return ok(c, inv, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

invoices.post('/:id/void', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    // Traer factura + items para devolver stock.
    const { data: existing, error: getErr } = await db.from('invoices')
      .select('id, status, invoice_items(product_id, quantity)')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (getErr) throw new Error(getErr.message);
    if (!existing) return fail(c, 'Factura no encontrada', 404);
    if (existing.status === 'cancelled') {
      return fail(c, 'La factura ya está anulada', 409);
    }

    // Marcar como cancelada.
    const { data, error } = await db.from('invoices')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);

    // Devolver stock para cada item, respetando productos sin control de stock.
    const items: Array<{ product_id: string; quantity: number }> = (existing as any).invoice_items ?? [];
    let restored = 0;
    for (const it of items) {
      const qty = Number(it.quantity ?? 0);
      if (!qty || qty <= 0) continue;
      const { data: p } = await db.from('products')
        .select('stock_quantity, tracks_stock')
        .eq('id', it.product_id).maybeSingle();
      if (!p) continue;
      if (p.tracks_stock === false) continue; // sin control de stock → no tocar
      await db.from('products').update({
        stock_quantity: Number(p.stock_quantity ?? 0) + qty,
        updated_at: new Date().toISOString(),
      }).eq('id', it.product_id);
      restored++;
    }

    console.log(`[VOID] Factura ${id}: stock devuelto en ${restored} productos`);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default invoices;
