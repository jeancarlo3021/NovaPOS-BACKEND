import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const purchases = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const ItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity:   z.number().positive(),
  unit_price: z.number().nonnegative(),
  subtotal:   z.number().nonnegative().optional().nullable(),
});

const PurchaseSchema = z.object({
  supplier_id:            z.string().uuid(),
  purchase_number:        z.string().min(1),
  purchase_date:          z.string(),
  expected_delivery_date: z.string().optional().nullable(),
  notes:                  z.string().optional().nullable(),
  total_amount:           z.number().nonnegative().optional().nullable(),
  items:                  z.array(ItemSchema).optional().default([]),
});

purchases.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status   = c.req.query('status');
    const from     = c.req.query('from');
    const to       = c.req.query('to');

    let query = db.from('purchases')
      .select('id, supplier_id, purchase_number, purchase_date, status, total_amount, notes')
      .eq('tenant_id', tenantId)
      .order('purchase_date', { ascending: false });
    if (status) query = query.eq('status', status);
    if (from) query = query.gte('purchase_date', from);
    if (to) query = query.lte('purchase_date', to);

    const { data: purchases, error } = await query;
    if (error) throw new Error(error.message);

    // Get supplier names
    const supplierIds = [...new Set((purchases ?? []).map((p: any) => p.supplier_id))];
    const { data: suppliers } = await db.from('suppliers')
      .select('id, name').in('id', supplierIds);

    const result = (purchases ?? []).map((p: any) => ({
      ...p,
      supplier: (suppliers ?? []).find((s: any) => s.id === p.supplier_id) || null,
    }));

    return ok(c, result);
  } catch (err: any) { return fail(c, err.message, 500); }
});

purchases.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();

    // Get purchase
    const { data: purchase, error: pErr } = await db.from('purchases')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (pErr) throw new Error(pErr.message);
    if (!purchase) return fail(c, 'Compra no encontrada', 404);

    // Get supplier name
    const { data: supplier, error: sErr } = await db.from('suppliers')
      .select('name')
      .eq('id', purchase.supplier_id)
      .maybeSingle();

    if (sErr) console.error('Error fetching supplier:', sErr);

    // Get items for this purchase
    const { data: purchaseItems, error: iErr } = await db.from('purchase_items')
      .select('*')
      .eq('purchase_id', id);

    if (iErr) {
      console.error('Error fetching items:', iErr);
      return fail(c, 'Error al obtener items: ' + iErr.message, 500);
    }

    return ok(c, {
      ...purchase,
      suppliers: supplier ? { name: supplier.name } : null,
      purchase_items: purchaseItems || []
    });
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

// POST /:id/receive — mark as received, increment stock, create accounts payable if needed
purchases.post('/:id/receive', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const body = await c.req.json() as { items: { product_id: string; quantity: number }[]; canUpdateStock?: boolean; notes?: string };
    const { items, canUpdateStock = true, notes } = body;

    console.log(`[RECEIVE] Starting receive for purchase ${id}, tenant ${tenantId}`);

    // Get purchase
    const { data: purchase, error: pErr } = await db.from('purchases')
      .select('*')
      .eq('id', id).eq('tenant_id', tenantId).single();
    if (pErr) throw new Error(`Error fetching purchase: ${pErr.message}`);
    if (!purchase) return fail(c, 'Compra no encontrada', 404);

    console.log(`[RECEIVE] Purchase found:`, { id: purchase.id, supplier_id: purchase.supplier_id, total: purchase.total_amount });

    // Get supplier details
    const { data: supplier, error: sErr } = await db.from('suppliers')
      .select('name, payment_terms')
      .eq('id', purchase.supplier_id)
      .maybeSingle();

    console.log(`[RECEIVE] Supplier found:`, { name: supplier?.name, payment_terms: supplier?.payment_terms, error: sErr });

    // Mark as received
    const { data: updated, error: uErr } = await db.from('purchases')
      .update({ status: 'received', actual_delivery_date: new Date().toISOString().slice(0, 10), notes: notes || null, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select().single();
    if (uErr) throw new Error(`Error updating purchase: ${uErr.message}`);

    console.log(`[RECEIVE] Purchase marked as received`);

    // Incrementar stock por item, respetando tracks_stock por producto.
    // Cada incremento queda registrado en stock_adjustments para trazabilidad.
    if (canUpdateStock) {
      const userId = c.get('userId');
      let touched = 0;
      let skipped = 0;

      for (const item of (items ?? [])) {
        const qty = Number(item.quantity ?? 0);
        if (!qty || qty <= 0) continue;

        const { data: p } = await db.from('products')
          .select('stock_quantity, tracks_stock, name')
          .eq('id', item.product_id)
          .single();

        if (!p) continue;

        // Producto sin control de stock → no se toca ni se loguea.
        if (p.tracks_stock === false) {
          skipped++;
          continue;
        }

        const stockBefore = Number(p.stock_quantity ?? 0);
        const stockAfter  = stockBefore + qty;

        const { error: upErr } = await db.from('products').update({
          stock_quantity: stockAfter,
          updated_at: new Date().toISOString(),
        }).eq('id', item.product_id);

        if (upErr) {
          console.error(`[RECEIVE] ERROR updating stock for ${item.product_id}:`, upErr.message);
          continue;
        }

        // Registrar como ajuste tipo "increase" con motivo de compra.
        const { error: adjErr } = await db.from('stock_adjustments').insert({
          tenant_id: tenantId,
          product_id: item.product_id,
          user_id: userId ?? null,
          type: 'increase',
          quantity: qty,
          stock_before: stockBefore,
          stock_after: stockAfter,
          reason: `Compra ${purchase.purchase_number ?? ''}`.trim(),
          notes: supplier?.name ? `Recepción de ${supplier.name}` : 'Recepción de compra',
        });

        if (adjErr) {
          console.error(`[RECEIVE] ERROR logging stock_adjustment for ${item.product_id}:`, adjErr.message);
        }

        touched++;
      }

      console.log(`[RECEIVE] Stock incremented for ${touched} items, ${skipped} skipped (tracks_stock=false)`);
    } else {
      console.log(`[RECEIVE] Stock update skipped (canUpdateStock=false from plan)`);
    }

    // Create accounts payable if supplier has payment terms (credit)
    const paymentTerms = supplier?.payment_terms;
    console.log(`[RECEIVE] Payment terms: "${paymentTerms}", checking if credit...`);

    if (paymentTerms && paymentTerms.trim().toLowerCase() !== 'contado') {
      const dueDate = calculateDueDate(purchase.purchase_date, paymentTerms);
      console.log(`[RECEIVE] Creating AP: due_date=${dueDate}, amount=${purchase.total_amount}`);

      const { data: apData, error: apErr } = await db.from('accounts_payable').insert({
        tenant_id: tenantId,
        purchase_id: id,
        supplier_id: purchase.supplier_id,
        purchase_number: purchase.purchase_number,
        supplier_name: supplier?.name ?? 'Proveedor desconocido',
        total_amount: purchase.total_amount ?? 0,
        paid_amount: 0,
        due_date: dueDate,
        status: 'pending',
        payment_terms: paymentTerms,
        notes: purchase.notes,
      }).select().single();

      if (apErr) {
        console.error(`[RECEIVE] ERROR creating AP:`, apErr);
      } else {
        console.log(`[RECEIVE] AP created successfully:`, apData?.id);
      }
    } else {
      console.log(`[RECEIVE] Skipping AP creation - no credit terms`);
    }

    console.log(`[RECEIVE] Receive completed successfully`);
    return ok(c, updated);
  } catch (err: any) {
    console.error(`[RECEIVE] ERROR:`, err.message);
    return fail(c, err.message, 500);
  }
});

// Helper to calculate due date from payment terms
function calculateDueDate(baseDate: string, terms: string): string {
  const match = terms.match(/(\d+)/);
  if (!match) return baseDate;
  const days = parseInt(match[1]);
  const date = new Date(baseDate);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

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
