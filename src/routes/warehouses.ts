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

/**
 * Borra una bodega, o explica POR QUÉ no se puede.
 *
 * Antes se intentaba el borrado a secas y, cuando algo la referenciaba, salía en
 * pantalla el error crudo de la base: «violates foreign key constraint
 * transfers_from_warehouse_fkey». Eso no dice qué hay que hacer, y encima
 * esconde algo importante: los traslados son HISTORIAL y no se deben borrar.
 */
warehouses.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data: wh } = await db.from('warehouses')
      .select('id, name').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!wh) return fail(c, 'Bodega no encontrada', 404);
    const nombre = (wh as any).name ?? 'la bodega';

    const impedimentos: string[] = [];

    // 1) Traslados: son historial de movimientos de mercadería.
    try {
      const { count } = await db.from('transfers')
        .select('id', { count: 'exact', head: true })
        .or(`from_warehouse.eq.${id},to_warehouse.eq.${id}`);
      if (count) {
        impedimentos.push(`tiene ${count} traslado(s) en el historial`);
      }
    } catch { /* sin la tabla: no bloquea */ }

    // 2) Existencias: borrarla haría desaparecer mercadería del inventario.
    try {
      const { data: st } = await db.from('warehouse_stock')
        .select('quantity').eq('warehouse_id', id);
      const conSaldo = (st ?? []).filter((r: any) => Number(r.quantity ?? 0) !== 0).length;
      if (conSaldo) impedimentos.push(`todavía tiene existencias de ${conSaldo} producto(s)`);
    } catch { /* ignore */ }

    // 3) Rutas: si es un camión, borrarlo se llevaría sus rutas y sus ventas.
    try {
      const { count } = await db.from('routes')
        .select('id', { count: 'exact', head: true }).eq('warehouse_id', id);
      if (count) impedimentos.push(`es el camión de ${count} ruta(s)`);
    } catch { /* ignore */ }

    if (impedimentos.length) {
      return fail(c,
        `No se puede borrar «${nombre}»: ${impedimentos.join(', ')}.\n\n`
        + 'Ese historial tiene que conservarse: los traslados y las rutas respaldan movimientos '
        + 'de mercadería que ya ocurrieron. Si la bodega dejó de usarse, pasá sus existencias a '
        + 'otra con un traslado y dejala vacía, sin borrarla.', 409);
    }

    const { error } = await db.from('warehouses')
      .delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) {
      // Quedó algo que no previmos: se traduce en vez de mostrar el texto de la base.
      if (/foreign key|violates/i.test(error.message)) {
        const tabla = /on table "([^"]+)"/.exec(error.message)?.[1]
          ?? /constraint "([a-z_]+)_/.exec(error.message)?.[1];
        return fail(c,
          `No se puede borrar «${nombre}»: todavía hay registros que la usan`
          + `${tabla ? ` (en ${tabla})` : ''}. Vaciala y dejala sin uso en vez de borrarla.`, 409);
      }
      throw new Error(error.message);
    }
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
