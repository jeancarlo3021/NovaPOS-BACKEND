import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const transfers = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const CreateTransferSchema = z.object({
  from_warehouse: z.string().uuid(),
  to_warehouse: z.string().uuid(),
  notes: z.string().optional().nullable(),
  items: z.array(z.object({
    product_id: z.string().uuid(),
    quantity: z.number().positive(),
  })).min(1),
});

// GET /
transfers.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status');
    let query = db.from('stock_transfers')
      .select(`
        *,
        from_wh:warehouses!stock_transfers_from_warehouse_fkey(id, name, code, branch_id),
        to_wh:warehouses!stock_transfers_to_warehouse_fkey(id, name, code, branch_id),
        items:stock_transfer_items(id, product_id, quantity, product:products(id, name, sku))
      `)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /
transfers.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    const parsed = CreateTransferSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    if (parsed.data.from_warehouse === parsed.data.to_warehouse) {
      return fail(c, 'La bodega de origen y destino no pueden ser la misma', 422);
    }

    const { data: t, error } = await db.from('stock_transfers').insert({
      tenant_id: tenantId,
      from_warehouse: parsed.data.from_warehouse,
      to_warehouse:   parsed.data.to_warehouse,
      notes: parsed.data.notes ?? null,
      status: 'pending',
      created_by: userId,
    }).select().single();
    if (error) throw new Error(error.message);

    const itemRows = parsed.data.items.map(it => ({
      transfer_id: t.id,
      product_id: it.product_id,
      quantity: it.quantity,
    }));
    const { error: iErr } = await db.from('stock_transfer_items').insert(itemRows);
    if (iErr) throw new Error(iErr.message);

    return ok(c, t, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /:id/send — sale de la bodega origen (decrementa stock)
transfers.post('/:id/send', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data: t } = await db.from('stock_transfers').select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!t) return fail(c, 'Transferencia no encontrada', 404);
    if (t.status !== 'pending') return fail(c, `No se puede enviar (estado actual: ${t.status})`, 409);

    const { data: items } = await db.from('stock_transfer_items').select('*').eq('transfer_id', id);

    // Decrementar stock en la bodega origen para cada item.
    for (const it of (items ?? [])) {
      const { data: cur } = await db.from('product_stock')
        .select('quantity').eq('product_id', it.product_id).eq('warehouse_id', t.from_warehouse).maybeSingle();
      const next = Math.max(0, Number(cur?.quantity ?? 0) - Number(it.quantity));
      await db.from('product_stock').upsert({
        tenant_id: tenantId, product_id: it.product_id, warehouse_id: t.from_warehouse,
        quantity: next, updated_at: new Date().toISOString(),
      });
    }

    await db.from('stock_transfers').update({ status: 'in_transit', sent_at: new Date().toISOString() }).eq('id', id);
    return ok(c, { ok: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /:id/receive — llega a destino (incrementa stock)
transfers.post('/:id/receive', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    const { id } = c.req.param();

    const { data: t } = await db.from('stock_transfers').select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!t) return fail(c, 'Transferencia no encontrada', 404);
    if (t.status !== 'in_transit') return fail(c, `No se puede recibir (estado actual: ${t.status})`, 409);

    const { data: items } = await db.from('stock_transfer_items').select('*').eq('transfer_id', id);

    for (const it of (items ?? [])) {
      const { data: cur } = await db.from('product_stock')
        .select('quantity').eq('product_id', it.product_id).eq('warehouse_id', t.to_warehouse).maybeSingle();
      const next = Number(cur?.quantity ?? 0) + Number(it.quantity);
      await db.from('product_stock').upsert({
        tenant_id: tenantId, product_id: it.product_id, warehouse_id: t.to_warehouse,
        quantity: next, updated_at: new Date().toISOString(),
      });
    }

    await db.from('stock_transfers').update({
      status: 'received',
      received_at: new Date().toISOString(),
      received_by: userId,
    }).eq('id', id);

    return ok(c, { ok: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /:id/cancel
transfers.post('/:id/cancel', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data: t } = await db.from('stock_transfers').select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!t) return fail(c, 'Transferencia no encontrada', 404);
    if (t.status === 'received') return fail(c, 'No puedes cancelar una transferencia ya recibida', 409);

    // Si estaba in_transit, devolver el stock al origen.
    if (t.status === 'in_transit') {
      const { data: items } = await db.from('stock_transfer_items').select('*').eq('transfer_id', id);
      for (const it of (items ?? [])) {
        const { data: cur } = await db.from('product_stock')
          .select('quantity').eq('product_id', it.product_id).eq('warehouse_id', t.from_warehouse).maybeSingle();
        const next = Number(cur?.quantity ?? 0) + Number(it.quantity);
        await db.from('product_stock').upsert({
          tenant_id: tenantId, product_id: it.product_id, warehouse_id: t.from_warehouse,
          quantity: next, updated_at: new Date().toISOString(),
        });
      }
    }

    await db.from('stock_transfers').update({ status: 'cancelled' }).eq('id', id);
    return ok(c, { ok: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default transfers;
