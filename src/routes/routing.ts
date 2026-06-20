import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

// Módulo de Ruteo (reparto en camión). Ver migrations/18_routing.sql
const routing = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// ── Camiones (bodegas tipo 'truck') ──────────────────────────────────────────
routing.get('/trucks', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('warehouses')
      .select('id, name, code, type, driver_id, is_default')
      .eq('tenant_id', tenantId).eq('type', 'truck').order('name');
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// Bodega central del tenant (la default, o la primera 'central').
async function centralWarehouseId(tenantId: string): Promise<string | null> {
  const { data: def } = await db.from('warehouses')
    .select('id').eq('tenant_id', tenantId).eq('is_default', true).maybeSingle();
  if (def?.id) return def.id;
  const { data: first } = await db.from('warehouses')
    .select('id').eq('tenant_id', tenantId).neq('type', 'truck').order('created_at').limit(1).maybeSingle();
  return first?.id ?? null;
}

// ── Rutas ────────────────────────────────────────────────────────────────────
// GET /?date=&status=&driver_id=
routing.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const date   = c.req.query('date');
    const status = c.req.query('status');
    const driver = c.req.query('driver_id');
    let q = db.from('routes')
      .select('*, warehouse:warehouses!routes_warehouse_id_fkey(id, name, code)')
      .eq('tenant_id', tenantId)
      .order('route_date', { ascending: false });
    if (date)   q = q.eq('route_date', date);
    if (status) q = q.eq('status', status);
    if (driver) q = q.eq('driver_id', driver);
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    // Conteo de paradas por ruta.
    const ids = (data ?? []).map((r: any) => r.id);
    const counts: Record<string, { total: number; done: number }> = {};
    if (ids.length > 0) {
      const { data: stops } = await db.from('route_stops').select('route_id, status').in('route_id', ids);
      for (const s of (stops ?? []) as any[]) {
        counts[s.route_id] ??= { total: 0, done: 0 };
        counts[s.route_id].total++;
        if (s.status !== 'pending') counts[s.route_id].done++;
      }
    }
    return ok(c, (data ?? []).map((r: any) => ({ ...r, stops_total: counts[r.id]?.total ?? 0, stops_done: counts[r.id]?.done ?? 0 })));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id — ruta + paradas (con cliente)
routing.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data: route, error } = await db.from('routes')
      .select('*, warehouse:warehouses!routes_warehouse_id_fkey(id, name, code)')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!route) return fail(c, 'Ruta no encontrada', 404);

    const { data: stops } = await db.from('route_stops')
      .select('*, customer:customers(id, name, phone, address, email)')
      .eq('route_id', id).order('seq', { ascending: true });
    return ok(c, { ...route, stops: stops ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST / — crear ruta { warehouse_id, driver_id, modality, route_date, notes, stops:[{customer_id, seq, lat, lng}] }
routing.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    const b = await c.req.json();
    if (!b.warehouse_id) return fail(c, 'Falta el camión (warehouse_id)', 422);

    const { data: route, error } = await db.from('routes').insert({
      tenant_id: tenantId,
      warehouse_id: b.warehouse_id,
      driver_id: b.driver_id ?? null,
      modality: ['autoventa', 'preventa', 'ambas'].includes(b.modality) ? b.modality : 'ambas',
      route_date: b.route_date ?? new Date().toISOString().slice(0, 10),
      notes: b.notes ?? null,
      created_by: userId ?? null,
    }).select().single();
    if (error) throw new Error(error.message);

    const stops = Array.isArray(b.stops) ? b.stops : [];
    if (stops.length > 0) {
      const rows = stops.map((s: any, i: number) => ({
        tenant_id: tenantId, route_id: route.id, customer_id: s.customer_id,
        seq: s.seq ?? i, lat: s.lat ?? null, lng: s.lng ?? null,
      }));
      const { error: se } = await db.from('route_stops').insert(rows);
      if (se) console.warn('[routing] stops insert:', se.message);
    }
    return ok(c, route, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /:id/stops — reemplaza las paradas de la ruta
routing.put('/:id/stops', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const b = await c.req.json();
    const stops = Array.isArray(b.stops) ? b.stops : [];
    await db.from('route_stops').delete().eq('route_id', id).eq('tenant_id', tenantId);
    if (stops.length > 0) {
      const rows = stops.map((s: any, i: number) => ({
        tenant_id: tenantId, route_id: id, customer_id: s.customer_id,
        seq: s.seq ?? i, lat: s.lat ?? null, lng: s.lng ?? null,
      }));
      const { error } = await db.from('route_stops').insert(rows);
      if (error) throw new Error(error.message);
    }
    return ok(c, { ok: true, count: stops.length });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PATCH /stops/:id — actualizar estado/orden de una parada
routing.patch('/stops/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const b = await c.req.json();
    const patch: any = {};
    if (b.status !== undefined) patch.status = b.status;   // 'pending' | 'visited' | 'no_sale'
    if (b.reason !== undefined) patch.reason = b.reason;
    if (b.seq !== undefined)    patch.seq = b.seq;
    const { data, error } = await db.from('route_stops')
      .update(patch).eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/load — asignar carga al camión: mueve stock central → camión.
// body: { items: [{ product_id, quantity }] }
routing.post('/:id/load', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    const { id } = c.req.param();
    const b = await c.req.json();
    const items: Array<{ product_id: string; quantity: number }> = (b.items ?? [])
      .filter((it: any) => it.product_id && Number(it.quantity) > 0)
      .map((it: any) => ({ product_id: it.product_id, quantity: Number(it.quantity) }));
    if (items.length === 0) return fail(c, 'Sin productos para cargar', 422);

    const { data: route } = await db.from('routes')
      .select('id, warehouse_id, status').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!route) return fail(c, 'Ruta no encontrada', 404);
    if ((route as any).status === 'closed') return fail(c, 'La ruta está cerrada', 409);

    const truckId = (route as any).warehouse_id;
    const central = await centralWarehouseId(tenantId);
    if (!central || central === truckId) return fail(c, 'No se encontró la bodega central', 422);

    // Mover stock: central - , camión +
    for (const it of items) {
      const { data: cRow } = await db.from('warehouse_stock')
        .select('quantity').eq('warehouse_id', central).eq('product_id', it.product_id).maybeSingle();
      await db.from('warehouse_stock').upsert(
        { warehouse_id: central, product_id: it.product_id, quantity: Number(cRow?.quantity ?? 0) - it.quantity },
        { onConflict: 'warehouse_id,product_id' });
      const { data: tRow } = await db.from('warehouse_stock')
        .select('quantity').eq('warehouse_id', truckId).eq('product_id', it.product_id).maybeSingle();
      await db.from('warehouse_stock').upsert(
        { warehouse_id: truckId, product_id: it.product_id, quantity: Number(tRow?.quantity ?? 0) + it.quantity },
        { onConflict: 'warehouse_id,product_id' });
    }

    // Registrar el transfer (recibido).
    try {
      const { data: tr } = await db.from('transfers').insert({
        tenant_id: tenantId, from_warehouse: central, to_warehouse: truckId,
        status: 'received', notes: `Carga ruta ${id}`,
        created_by: userId ?? null, sent_at: new Date().toISOString(), received_at: new Date().toISOString(),
      }).select('id').single();
      if (tr?.id) {
        await db.from('transfer_items').insert(
          items.map(it => ({ transfer_id: tr.id, product_id: it.product_id, quantity: it.quantity })),
        );
      }
    } catch (e: any) { console.warn('[routing load] transfer:', e?.message); }

    return ok(c, { ok: true, loaded: items.length });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id/truck-stock — stock actual del camión de la ruta
routing.get('/:id/truck-stock', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data: route } = await db.from('routes')
      .select('warehouse_id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!route) return fail(c, 'Ruta no encontrada', 404);
    const { data } = await db.from('warehouse_stock')
      .select('product_id, quantity, product:products!warehouse_stock_product_id_fkey(id, name, sku, unit_price)')
      .eq('warehouse_id', (route as any).warehouse_id);
    return ok(c, (data ?? []).filter((s: any) => Number(s.quantity) !== 0));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/close — corte del día: devuelve el sobrante del camión a la central
// y genera el resumen (ventas, anulaciones). Sin caja chica.
routing.post('/:id/close', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    const { id } = c.req.param();

    const { data: route } = await db.from('routes')
      .select('id, warehouse_id, status, route_date').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!route) return fail(c, 'Ruta no encontrada', 404);
    if ((route as any).status === 'closed') return fail(c, 'La ruta ya está cerrada', 409);

    const truckId = (route as any).warehouse_id;
    const central = await centralWarehouseId(tenantId);

    // 1) Devolver el sobrante del camión a la central (transfer recibido al instante).
    let returnedItems: Array<{ product_id: string; quantity: number }> = [];
    if (central && central !== truckId) {
      const { data: stock } = await db.from('warehouse_stock')
        .select('product_id, quantity').eq('warehouse_id', truckId);
      returnedItems = (stock ?? []).filter((s: any) => Number(s.quantity) > 0)
        .map((s: any) => ({ product_id: s.product_id, quantity: Number(s.quantity) }));

      if (returnedItems.length > 0) {
        // Mover stock: camión - , central + ; y registrar el transfer como recibido.
        for (const it of returnedItems) {
          const { data: cRow } = await db.from('warehouse_stock')
            .select('quantity').eq('warehouse_id', central).eq('product_id', it.product_id).maybeSingle();
          await db.from('warehouse_stock').upsert(
            { warehouse_id: central, product_id: it.product_id, quantity: Number(cRow?.quantity ?? 0) + it.quantity },
            { onConflict: 'warehouse_id,product_id' });
          await db.from('warehouse_stock').upsert(
            { warehouse_id: truckId, product_id: it.product_id, quantity: 0 },
            { onConflict: 'warehouse_id,product_id' });
        }
        try {
          const { data: tr } = await db.from('transfers').insert({
            tenant_id: tenantId, from_warehouse: truckId, to_warehouse: central,
            status: 'received', notes: `Devolución cierre de ruta ${id}`,
            created_by: userId ?? null, sent_at: new Date().toISOString(), received_at: new Date().toISOString(),
          }).select('id').single();
          if (tr?.id) {
            await db.from('transfer_items').insert(
              returnedItems.map(it => ({ transfer_id: tr.id, product_id: it.product_id, quantity: it.quantity })),
            );
          }
        } catch (e: any) { console.warn('[routing close] registro de transfer:', e?.message); }
      }
    }

    // 2) Resumen de ventas/anulaciones de la ruta.
    const { data: invs } = await db.from('invoices')
      .select('total, status').eq('tenant_id', tenantId).eq('route_id', id);
    const sales = (invs ?? []).filter((i: any) => i.status !== 'cancelled');
    const voids = (invs ?? []).filter((i: any) => i.status === 'cancelled');
    const salesTotal = sales.reduce((s: number, i: any) => s + Number(i.total ?? 0), 0);

    // 3) Cerrar la ruta.
    await db.from('routes').update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId);

    return ok(c, {
      route_id: id,
      sales_count: sales.length,
      sales_total: salesTotal,
      voids_count: voids.length,
      returned_items: returnedItems.length,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default routing;
