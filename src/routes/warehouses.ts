import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const warehouses = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// GET / — lista warehouses del tenant (opcional ?branch_id=)
warehouses.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return ok(c, []);
    const branchId = c.req.query('branch_id');
    let q = db.from('warehouses')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('name');
    if (branchId) q = q.eq('branch_id', branchId);
    const { data, error } = await q;
    if (error) {
      console.error('[warehouses] select error:', error.message);
      throw new Error(error.message);
    }

    // Hidratar branch en JS (más confiable que joins nominados)
    let result = data ?? [];
    const branchIds = Array.from(new Set(result.map((w: any) => w.branch_id).filter(Boolean)));
    if (branchIds.length > 0) {
      const { data: branchRows } = await db.from('branches')
        .select('id, name, code').in('id', branchIds);
      const map = new Map<string, any>();
      for (const b of (branchRows ?? []) as any[]) map.set(b.id, b);
      result = result.map((w: any) => ({ ...w, branch: map.get(w.branch_id) ?? null }));
    }
    return ok(c, result);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST / — crear warehouse
warehouses.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return fail(c, 'Tenant requerido', 400);
    const body = await c.req.json();
    if (!body.branch_id) return fail(c, 'branch_id requerido', 422);
    const { data, error } = await db.from('warehouses').insert({
      tenant_id:  tenantId,
      branch_id:  body.branch_id,
      name:       body.name,
      code:       body.code ?? null,
      is_active:  body.is_active ?? true,
      is_default: body.is_default ?? false,
      type:       body.type === 'truck' ? 'truck' : 'central',
      driver_id:  body.driver_id ?? null,
    }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

warehouses.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const { data, error } = await db.from('warehouses')
      .update(body).eq('id', id).eq('tenant_id', tenantId)
      .select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

warehouses.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db.from('warehouses')
      .delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

warehouses.post('/:id/set-default', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    await db.from('warehouses').update({ is_default: false }).eq('tenant_id', tenantId);
    const { error } = await db.from('warehouses')
      .update({ is_default: true }).eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id/stock — stock por producto
warehouses.get('/:id/stock', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    // Validar pertenencia
    const { data: wh } = await db.from('warehouses')
      .select('id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!wh) return fail(c, 'Bodega no encontrada', 404);
    const { data, error } = await db.from('warehouse_stock')
      .select('product_id, warehouse_id, quantity, min_level, product:products!warehouse_stock_product_id_fkey(id, name, sku, unit_price, min_stock_level)')
      .eq('warehouse_id', id);
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /:id/stock/:productId — setear stock
warehouses.put('/:id/stock/:productId', async (c) => {
  try {
    const { id, productId } = c.req.param();
    const body = await c.req.json();
    const { error } = await db.from('warehouse_stock').upsert({
      warehouse_id: id,
      product_id:   productId,
      quantity:     body.quantity,
      min_level:    body.min_level ?? null,
    }, { onConflict: 'warehouse_id,product_id' });
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default warehouses;
