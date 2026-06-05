import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const warehouses = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const CreateWarehouseSchema = z.object({
  branch_id: z.string().uuid(),
  name: z.string().min(1),
  code: z.string().min(1).max(20),
});

const UpdateWarehouseSchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().min(1).max(20).optional(),
  is_active: z.boolean().optional(),
});

// GET /?branch_id= — lista; si branch_id, filtra
warehouses.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const branchId = c.req.query('branch_id');

    let query = db.from('warehouses').select('*, branch:branches(id, name, code)').eq('tenant_id', tenantId);
    if (branchId) query = query.eq('branch_id', branchId);

    const { data, error } = await query.order('is_default', { ascending: false }).order('code');
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — crear bodega
warehouses.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = CreateWarehouseSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Verifica que la branch pertenezca al tenant
    const { data: branch } = await db.from('branches').select('id').eq('id', parsed.data.branch_id).eq('tenant_id', tenantId).maybeSingle();
    if (!branch) return fail(c, 'Sucursal no encontrada', 404);

    const { data, error } = await db.from('warehouses')
      .insert({ tenant_id: tenantId, ...parsed.data })
      .select()
      .single();
    if (error) {
      if (error.message.includes('warehouses_branch_id_code_key') || error.message.includes('duplicate')) {
        return fail(c, `Ya existe una bodega con el código "${parsed.data.code}" en esta sucursal`, 409);
      }
      throw new Error(error.message);
    }
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /:id
warehouses.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const parsed = UpdateWarehouseSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db.from('warehouses')
      .update(parsed.data)
      .eq('id', id).eq('tenant_id', tenantId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Bodega no encontrada', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /:id/set-default — bodega default de su sucursal
warehouses.post('/:id/set-default', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data: w } = await db.from('warehouses').select('branch_id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!w) return fail(c, 'Bodega no encontrada', 404);
    await db.from('warehouses').update({ is_default: false }).eq('branch_id', w.branch_id);
    const { error } = await db.from('warehouses').update({ is_default: true }).eq('id', id);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /:id — desactivar
warehouses.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data: w } = await db.from('warehouses').select('is_default').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (w?.is_default) return fail(c, 'No puedes desactivar la bodega principal. Marca otra como principal primero.', 409);
    const { error } = await db.from('warehouses').update({ is_active: false }).eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// ── product_stock por bodega ──────────────────────────────────────────────

// GET /:id/stock — stock de productos en esta bodega
warehouses.get('/:id/stock', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data, error } = await db
      .from('product_stock')
      .select('*, product:products(id, name, sku, unit_price, min_stock_level)')
      .eq('warehouse_id', id)
      .eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /:id/stock/:productId — fijar stock manual de un producto en esta bodega
warehouses.put('/:id/stock/:productId', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id, productId } = c.req.param();
    const body = await c.req.json() as { quantity: number; min_level?: number | null };
    if (typeof body.quantity !== 'number' || body.quantity < 0) {
      return fail(c, 'quantity inválido', 422);
    }
    const { error } = await db.from('product_stock')
      .upsert({
        tenant_id: tenantId,
        product_id: productId,
        warehouse_id: id,
        quantity: body.quantity,
        min_level: body.min_level ?? null,
        updated_at: new Date().toISOString(),
      });
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default warehouses;
