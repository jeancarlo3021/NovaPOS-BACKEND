import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const transfers = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// GET / — lista transfers del tenant
transfers.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return ok(c, []);
    const { data, error } = await db.from('transfers')
      .select(`
        *,
        items:transfer_items(id, product_id, quantity, product:products!transfer_items_product_id_fkey(id, name, sku))
      `)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST / — crear transfer (pending)
transfers.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    if (!tenantId) return fail(c, 'Tenant requerido', 400);
    const body = await c.req.json();
    const { from_warehouse, to_warehouse, notes, items } = body;
    if (!from_warehouse || !to_warehouse) return fail(c, 'Bodegas requeridas', 422);
    if (from_warehouse === to_warehouse) return fail(c, 'Origen y destino deben ser distintos', 422);
    if (!Array.isArray(items) || items.length === 0) return fail(c, 'Items requeridos', 422);

    const { data: t, error: tErr } = await db.from('transfers').insert({
      tenant_id: tenantId,
      from_warehouse, to_warehouse,
      status: 'pending', notes: notes ?? null,
      created_by: userId,
    }).select().single();
    if (tErr) throw new Error(tErr.message);

    const rows = items.map((it: any) => ({
      transfer_id: t.id, product_id: it.product_id, quantity: Number(it.quantity),
    }));
    const { error: iErr } = await db.from('transfer_items').insert(rows);
    if (iErr) throw new Error(iErr.message);

    return ok(c, { ...t, items: rows });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/send → in_transit
transfers.post('/:id/send', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db.from('transfers')
      .update({ status: 'in_transit', sent_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).eq('status', 'pending');
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/receive → received (descuenta de origen, suma a destino)
transfers.post('/:id/receive', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data: t } = await db.from('transfers')
      .select('id, from_warehouse, to_warehouse, status, items:transfer_items(product_id, quantity)')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!t) return fail(c, 'Transferencia no encontrada', 404);
    if (t.status !== 'in_transit') return fail(c, 'Solo se reciben transferencias en tránsito', 422);

    // Mover stock: origen -, destino +
    for (const it of (t.items ?? []) as any[]) {
      const qty = Number(it.quantity);
      // Origen: bajar (si no existe la fila, queda en negativo — el cliente decide)
      const { data: fromRow } = await db.from('warehouse_stock')
        .select('quantity').eq('warehouse_id', t.from_warehouse).eq('product_id', it.product_id).maybeSingle();
      await db.from('warehouse_stock').upsert({
        warehouse_id: t.from_warehouse, product_id: it.product_id,
        quantity: Number(fromRow?.quantity ?? 0) - qty,
      }, { onConflict: 'warehouse_id,product_id' });
      // Destino: subir
      const { data: toRow } = await db.from('warehouse_stock')
        .select('quantity').eq('warehouse_id', t.to_warehouse).eq('product_id', it.product_id).maybeSingle();
      await db.from('warehouse_stock').upsert({
        warehouse_id: t.to_warehouse, product_id: it.product_id,
        quantity: Number(toRow?.quantity ?? 0) + qty,
      }, { onConflict: 'warehouse_id,product_id' });
    }

    const { error } = await db.from('transfers')
      .update({ status: 'received', received_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/cancel
transfers.post('/:id/cancel', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db.from('transfers')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId)
      .in('status', ['pending', 'in_transit']);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── Cross-tenant: transferencia de bodega central → inventario de OTRA sucursal
//    (otro tenant del mismo grupo donde el caller también es owner).
//
//    Modelo:
//      - El caller debe ser owner del tenant origen (donde está la bodega).
//      - El caller debe ser owner del tenant destino (otra sucursal del grupo).
//      - Se descuenta de warehouse_stock del origen.
//      - Se busca el producto en el destino por SKU (más confiable que nombre).
//      - Si no existe, se replica el producto en el tenant destino con stock 0
//        y luego se le suma. Esto permite "popular" inventario nuevo.
//      - Si el destino tiene bodega default, el stock va a esa bodega; si no,
//        se actualiza products.stock_quantity directamente.
transfers.post('/cross-tenant', async (c) => {
  try {
    const callerUserId = c.get('userId');
    const body = await c.req.json();
    const { from_warehouse, to_tenant_id, notes, items } = body;

    if (!from_warehouse) return fail(c, 'from_warehouse requerido', 422);
    if (!to_tenant_id)   return fail(c, 'to_tenant_id requerido', 422);
    if (!Array.isArray(items) || items.length === 0) return fail(c, 'items requeridos', 422);

    // 1. Resolver tenant origen desde la bodega y validar ownership
    const { data: wh } = await db.from('warehouses')
      .select('id, tenant_id, name').eq('id', from_warehouse).maybeSingle();
    if (!wh) return fail(c, 'Bodega origen no encontrada', 404);
    const fromTenantId = wh.tenant_id;
    if (fromTenantId === to_tenant_id) return fail(c, 'Origen y destino deben ser sucursales distintas', 422);

    // Caller debe ser owner de ambos tenants
    const { data: ownerCheck } = await db.from('user_tenants')
      .select('tenant_id').eq('user_id', callerUserId).eq('role', 'owner')
      .in('tenant_id', [fromTenantId, to_tenant_id]);
    const ownedSet = new Set((ownerCheck ?? []).map((r: any) => r.tenant_id));
    if (!ownedSet.has(fromTenantId) || !ownedSet.has(to_tenant_id)) {
      return fail(c, 'Tenés que ser owner de ambas sucursales para transferir entre ellas', 403);
    }

    // 2. Resolver bodega default del destino (si existe) — sino, actualizamos
    //    products.stock_quantity directamente.
    const { data: destWh } = await db.from('warehouses')
      .select('id').eq('tenant_id', to_tenant_id).eq('is_default', true).maybeSingle();
    const destWarehouseId = destWh?.id ?? null;

    let moved = 0;
    const errors: string[] = [];

    for (const it of items) {
      const qty = Number(it.quantity);
      if (!it.product_id || !(qty > 0)) { errors.push('item inválido'); continue; }

      // 3a. Buscar producto en origen por id (es del fromTenant)
      const { data: srcProduct } = await db.from('products')
        .select('id, sku, name, unit_price').eq('id', it.product_id).maybeSingle();
      if (!srcProduct) { errors.push(`producto ${it.product_id} no existe en origen`); continue; }

      // 3b. Descontar stock en warehouse_stock del origen
      const { data: fromRow } = await db.from('warehouse_stock')
        .select('quantity').eq('warehouse_id', from_warehouse).eq('product_id', srcProduct.id).maybeSingle();
      await db.from('warehouse_stock').upsert({
        warehouse_id: from_warehouse, product_id: srcProduct.id,
        quantity: Number(fromRow?.quantity ?? 0) - qty,
      }, { onConflict: 'warehouse_id,product_id' });

      // 4. Buscar producto matching en destino por SKU (o crear)
      let destProductId: string | null = null;
      if (srcProduct.sku) {
        const { data: dp } = await db.from('products')
          .select('id').eq('tenant_id', to_tenant_id).eq('sku', srcProduct.sku).maybeSingle();
        destProductId = dp?.id ?? null;
      }
      if (!destProductId) {
        // Crear producto en destino replicando datos base
        const { data: created, error: cErr } = await db.from('products').insert({
          tenant_id: to_tenant_id, name: srcProduct.name,
          sku: srcProduct.sku ?? null, unit_price: srcProduct.unit_price ?? 0,
          stock_quantity: 0, is_active: true,
        }).select('id').single();
        if (cErr) { errors.push(`no se pudo crear "${srcProduct.name}" en destino: ${cErr.message}`); continue; }
        destProductId = created.id;
      }

      // 5. Sumar al stock del destino
      if (destWarehouseId) {
        const { data: toRow } = await db.from('warehouse_stock')
          .select('quantity').eq('warehouse_id', destWarehouseId).eq('product_id', destProductId).maybeSingle();
        await db.from('warehouse_stock').upsert({
          warehouse_id: destWarehouseId, product_id: destProductId,
          quantity: Number(toRow?.quantity ?? 0) + qty,
        }, { onConflict: 'warehouse_id,product_id' });
      } else {
        // Sin bodega → actualizar stock_quantity del producto destino
        const { data: dProd } = await db.from('products')
          .select('stock_quantity').eq('id', destProductId).maybeSingle();
        await db.from('products')
          .update({ stock_quantity: Number(dProd?.stock_quantity ?? 0) + qty })
          .eq('id', destProductId);
      }

      moved++;
    }

    // 6. Registrar el movimiento en transfers (status='received' directo, ya
    //    que es una transferencia inter-sucursal aplicada inmediatamente).
    const { data: tr } = await db.from('transfers').insert({
      tenant_id:  fromTenantId,
      from_warehouse,
      to_warehouse: destWarehouseId ?? from_warehouse,  // workaround si no hay default
      status: 'received',
      notes: `Cross-tenant → ${to_tenant_id}${notes ? ' · ' + notes : ''}`,
      created_by: callerUserId,
      sent_at: new Date().toISOString(),
      received_at: new Date().toISOString(),
    }).select().single();
    if (tr) {
      const itemRows = items.map((it: any) => ({
        transfer_id: tr.id, product_id: it.product_id, quantity: Number(it.quantity),
      }));
      await db.from('transfer_items').insert(itemRows);
    }

    return ok(c, { moved, errors, transfer_id: tr?.id });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default transfers;
