import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { createReceivable } from './accountsReceivable.js';

// Módulo de Ruteo (reparto en camión). Ver migrations/18_routing.sql
const routing = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// GET /report?from=&to= — reporte de rutas y camiones con sus ventas.
routing.get('/report', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = c.req.query('to');

    let rq = db.from('routes')
      .select('id, route_date, status, modality, warehouse_id, driver_id, warehouse:warehouses!routes_warehouse_id_fkey(id, name)')
      .eq('tenant_id', tenantId).order('route_date', { ascending: false });
    if (from) rq = rq.gte('route_date', from);
    if (to)   rq = rq.lte('route_date', to);
    const { data: routes, error } = await rq;
    if (error) throw new Error(error.message);

    const routeIds = (routes ?? []).map((r: any) => r.id);
    // Ventas por ruta + desglose por método de pago.
    const salesByRoute: Record<string, { count: number; total: number; voids: number; cash: number; card: number; sinpe: number; credit: number }> = {};
    const totalsByMethod = { cash: 0, card: 0, sinpe: 0, credit: 0 };
    if (routeIds.length > 0) {
      const { data: invs } = await db.from('invoices')
        .select('route_id, total, status, payment_method').eq('tenant_id', tenantId).in('route_id', routeIds);
      for (const i of (invs ?? []) as any[]) {
        const k = i.route_id;
        salesByRoute[k] ??= { count: 0, total: 0, voids: 0, cash: 0, card: 0, sinpe: 0, credit: 0 };
        if (i.status === 'cancelled') { salesByRoute[k].voids++; continue; }
        salesByRoute[k].count++;
        const t = Number(i.total ?? 0);
        salesByRoute[k].total += t;
        const m = (i.payment_method ?? 'cash') as 'cash' | 'card' | 'sinpe' | 'credit';
        if (m === 'card' || m === 'sinpe' || m === 'credit') { salesByRoute[k][m] += t; totalsByMethod[m] += t; }
        else { salesByRoute[k].cash += t; totalsByMethod.cash += t; }
      }
    }
    // Nombres de repartidor.
    const driverIds = [...new Set((routes ?? []).map((r: any) => r.driver_id).filter(Boolean))] as string[];
    const driverName = new Map<string, string>();
    if (driverIds.length > 0) {
      const { data: us } = await db.from('users').select('id, full_name, email').in('id', driverIds);
      for (const u of us ?? []) driverName.set((u as any).id, (u as any).full_name || (u as any).email);
    }

    const routeRows = (routes ?? []).map((r: any) => ({
      id: r.id, route_date: r.route_date, status: r.status, modality: r.modality,
      truck: r.warehouse?.name ?? '—', truck_id: r.warehouse_id,
      driver: r.driver_id ? (driverName.get(r.driver_id) ?? '—') : 'Sin asignar',
      sales_count: salesByRoute[r.id]?.count ?? 0,
      sales_total: salesByRoute[r.id]?.total ?? 0,
      voids_count: salesByRoute[r.id]?.voids ?? 0,
      cash: salesByRoute[r.id]?.cash ?? 0,
      card: salesByRoute[r.id]?.card ?? 0,
      sinpe: salesByRoute[r.id]?.sinpe ?? 0,
      credit: salesByRoute[r.id]?.credit ?? 0,
    }));

    // Agregado por camión.
    const byTruck: Record<string, { truck: string; routes: number; sales_count: number; sales_total: number }> = {};
    for (const r of routeRows) {
      byTruck[r.truck_id] ??= { truck: r.truck, routes: 0, sales_count: 0, sales_total: 0 };
      byTruck[r.truck_id].routes++;
      byTruck[r.truck_id].sales_count += r.sales_count;
      byTruck[r.truck_id].sales_total += r.sales_total;
    }

    return ok(c, { routes: routeRows, trucks: Object.values(byTruck), by_method: totalsByMethod });
  } catch (err: any) { return fail(c, err.message, 500); }
});

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

// Consecutivo único por tenant (mismo esquema que el POS: 000001, 000002, ...).
// IMPORTANTE: solo contamos números consecutivos SIMPLES (1-6 dígitos puros).
// Si tomáramos los dígitos finales de cualquier factura, una clave de FE o un
// número con fecha (ej. 20260627) haría saltar el consecutivo a algo tipo fecha.
async function nextInvoiceNumber(tenantId: string, attemptOffset = 0): Promise<string> {
  const { data } = await db.from('invoices').select('invoice_number').eq('tenant_id', tenantId);
  let maxSeq = 0;
  for (const r of (data ?? []) as any[]) {
    const s = String(r.invoice_number ?? '').trim();
    if (/^\d{1,6}$/.test(s)) maxSeq = Math.max(maxSeq, parseInt(s, 10));
  }
  return String(maxSeq + 1 + attemptOffset).padStart(6, '0');
}

// ── Vista del repartidor: sus rutas y sus pedidos por entregar ──────────────
// GET /mine — rutas asignadas al usuario actual (repartidor).
routing.get('/mine', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    const { data, error } = await db.from('routes')
      .select('*, warehouse:warehouses!routes_warehouse_id_fkey(id, name, code)')
      .eq('tenant_id', tenantId).eq('driver_id', userId)
      .order('route_date', { ascending: false });
    if (error) throw new Error(error.message);
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

// GET /my-orders — pedidos (preventa) pendientes de TODAS las rutas del repartidor.
routing.get('/my-orders', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    const { data: routes } = await db.from('routes')
      .select('id, route_date, warehouse:warehouses!routes_warehouse_id_fkey(name)')
      .eq('tenant_id', tenantId).eq('driver_id', userId);
    const routeIds = (routes ?? []).map((r: any) => r.id);
    if (routeIds.length === 0) return ok(c, []);
    const routeInfo = new Map((routes ?? []).map((r: any) => [r.id, { date: r.route_date, truck: r.warehouse?.name }]));

    const { data: orders } = await db.from('route_orders')
      .select('*, customer:customers(id, name, address, phone), items:route_order_items(product_id, quantity, unit_price)')
      .in('route_id', routeIds).eq('status', 'pending').order('created_at', { ascending: true });

    const pids = [...new Set((orders ?? []).flatMap((o: any) => (o.items ?? []).map((it: any) => it.product_id)))];
    const nameMap = new Map<string, string>();
    if (pids.length > 0) {
      const { data: prods } = await db.from('products').select('id, name').in('id', pids as string[]);
      for (const p of prods ?? []) nameMap.set((p as any).id, (p as any).name);
    }
    const out = (orders ?? []).map((o: any) => ({
      ...o,
      route: routeInfo.get(o.route_id) ?? null,
      items: (o.items ?? []).map((it: any) => ({ ...it, product_name: nameMap.get(it.product_id) ?? 'Producto' })),
    }));
    return ok(c, out);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── Rutas ────────────────────────────────────────────────────────────────────
// GET /?date=&from=&to=&status=&driver_id=
routing.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const date   = c.req.query('date');
    const from   = c.req.query('from');
    const to     = c.req.query('to');
    const status = c.req.query('status');
    const driver = c.req.query('driver_id');
    let q = db.from('routes')
      .select('*, warehouse:warehouses!routes_warehouse_id_fkey(id, name, code)')
      .eq('tenant_id', tenantId)
      .order('route_date', { ascending: false });
    if (date)   q = q.eq('route_date', date);
    if (from)   q = q.gte('route_date', from);   // rango de fechas (inclusive)
    if (to)     q = q.lte('route_date', to);
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

// GET /central-stock — stock del INVENTARIO DEL SISTEMA (products), para "Cargar".
// IMPORTANTE: debe ir ANTES de /:id, si no '/:id' captura 'central-stock'.
// Valor -1 = stock infinito (producto sin control de inventario).
routing.get('/central-stock', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data } = await db.from('products')
      .select('id, stock_quantity, tracks_stock').eq('tenant_id', tenantId);
    const map: Record<string, number> = {};
    for (const p of (data ?? []) as any[]) {
      map[p.id] = p.tracks_stock === false ? -1 : Number(p.stock_quantity ?? 0);
    }
    return ok(c, map);
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

    // Un camión solo puede tener UNA ruta abierta a la vez. La carga se guarda
    // por camión (warehouse_stock), así que dos rutas abiertas con el mismo
    // camión compartirían el stock. Hay que cerrar la anterior primero.
    const { data: openRoute } = await db.from('routes')
      .select('id, route_date')
      .eq('tenant_id', tenantId).eq('warehouse_id', b.warehouse_id).eq('status', 'open')
      .maybeSingle();
    if (openRoute) {
      return fail(c, 'Ese camión ya tiene una ruta abierta. Cerrá esa ruta antes de crear otra con el mismo camión.', 409);
    }

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

    // Mover stock: descuenta del INVENTARIO DEL SISTEMA (products.stock_quantity)
    // y suma al camión (warehouse_stock). Productos de stock infinito no se descuentan.
    for (const it of items) {
      const { data: prod } = await db.from('products')
        .select('stock_quantity, tracks_stock').eq('id', it.product_id).eq('tenant_id', tenantId).maybeSingle();
      if (prod && (prod as any).tracks_stock !== false) {
        await db.from('products').update({
          stock_quantity: Math.max(0, Number((prod as any).stock_quantity ?? 0) - it.quantity),
          updated_at: new Date().toISOString(),
        }).eq('id', it.product_id);
      }
      const { data: tRow } = await db.from('warehouse_stock')
        .select('quantity').eq('warehouse_id', truckId).eq('product_id', it.product_id).maybeSingle();
      await db.from('warehouse_stock').upsert(
        { warehouse_id: truckId, product_id: it.product_id, quantity: Number(tRow?.quantity ?? 0) + it.quantity },
        { onConflict: 'warehouse_id,product_id' });
    }

    // Acumular lo cargado en routes.loaded_summary (para reconstruir sobrante).
    try {
      const { data: r } = await db.from('routes').select('loaded_summary').eq('id', id).maybeSingle();
      const acc: Record<string, number> = { ...((r as any)?.loaded_summary ?? {}) };
      for (const it of items) acc[it.product_id] = Number(acc[it.product_id] ?? 0) + it.quantity;
      await db.from('routes').update({ loaded_summary: acc }).eq('id', id).eq('tenant_id', tenantId);
    } catch { /* columna loaded_summary no existe todavía */ }

    void userId;
    return ok(c, { ok: true, loaded: items.length });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/clear-load — BORRAR la carga del camión (devuelve TODO al inventario del
// sistema) sin cerrar la ruta. Para corregir una carga hecha por error.
routing.post('/:id/clear-load', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data: route } = await db.from('routes')
      .select('id, warehouse_id, status').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!route) return fail(c, 'Ruta no encontrada', 404);
    if ((route as any).status === 'closed') return fail(c, 'La ruta está cerrada', 409);

    // Si ya hubo ventas en esta ruta, no se puede borrar la carga (el stock no cuadra).
    const { count: salesCount } = await db.from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('route_id', id).neq('status', 'cancelled');
    if ((salesCount ?? 0) > 0) {
      return fail(c, 'No se puede borrar la carga: la ruta ya tiene ventas. Anulá las ventas o cerrá la ruta.', 409);
    }

    const truckId = (route as any).warehouse_id;
    const { data: stock } = await db.from('warehouse_stock')
      .select('product_id, quantity').eq('warehouse_id', truckId);
    const rows = (stock ?? []).filter((s: any) => Number(s.quantity) > 0);

    for (const it of rows as any[]) {
      const { data: prod } = await db.from('products')
        .select('stock_quantity, tracks_stock').eq('id', it.product_id).eq('tenant_id', tenantId).maybeSingle();
      if (prod && (prod as any).tracks_stock !== false) {
        await db.from('products').update({
          stock_quantity: Number((prod as any).stock_quantity ?? 0) + Number(it.quantity),
          updated_at: new Date().toISOString(),
        }).eq('id', it.product_id);
      }
      await db.from('warehouse_stock').upsert(
        { warehouse_id: truckId, product_id: it.product_id, quantity: 0 },
        { onConflict: 'warehouse_id,product_id' });
    }

    // La carga se borró: reiniciar el acumulado de cargado.
    try { await db.from('routes').update({ loaded_summary: {} }).eq('id', id).eq('tenant_id', tenantId); } catch { /* sin columna */ }

    return ok(c, { ok: true, returned_items: rows.length });
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
      .select('product_id, quantity, product:products!warehouse_stock_product_id_fkey(id, name, sku, unit_price, category_id, unit_type:unit_types(name, abbreviation))')
      .eq('warehouse_id', (route as any).warehouse_id);
    return ok(c, (data ?? []).filter((s: any) => Number(s.quantity) !== 0));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/sale — AUTOVENTA: factura que descuenta del stock del CAMIÓN.
// Valida que no se venda más de lo cargado (bloqueante). Sin caja chica.
routing.post('/:id/sale', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const b = await c.req.json();
    const items: any[] = Array.isArray(b.items) ? b.items : [];
    if (items.length === 0) return fail(c, 'Sin productos', 422);

    const { data: route } = await db.from('routes')
      .select('id, warehouse_id, status').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!route) return fail(c, 'Ruta no encontrada', 404);
    if ((route as any).status === 'closed') return fail(c, 'La ruta está cerrada', 409);
    const truckId = (route as any).warehouse_id;

    // Validar stock del camión (bloqueante).
    const pids = [...new Set(items.map(i => i.product_id))];
    const { data: stockRows } = await db.from('warehouse_stock')
      .select('product_id, quantity').eq('warehouse_id', truckId).in('product_id', pids);
    const stockMap = new Map((stockRows ?? []).map((s: any) => [s.product_id, Number(s.quantity)]));
    const { data: prods } = await db.from('products').select('id, name').in('id', pids);
    const nameMap = new Map((prods ?? []).map((p: any) => [p.id, p.name]));
    for (const it of items) {
      const avail = stockMap.get(it.product_id) ?? 0;
      if (Number(it.quantity) > avail) {
        return fail(c, `Sin stock en el camión de "${nameMap.get(it.product_id) ?? 'producto'}": cargado ${avail}, pedido ${it.quantity}`, 409);
      }
    }

    // Crear factura (route_id, sin caja chica) con consecutivo único.
    let inv: any = null, invErr: any = null;
    let finalNumber = await nextInvoiceNumber(tenantId);
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await db.from('invoices').insert({
        tenant_id: tenantId,
        cash_session_id: null,
        route_id: id,
        invoice_number: finalNumber,
        subtotal: b.subtotal ?? 0,
        discount_amount: b.discount_amount ?? 0,
        tax_amount: b.tax_amount ?? 0,
        total: b.total ?? 0,
        payment_method: b.payment_method ?? 'cash',
        payments: (b.payments && b.payments.length > 1) ? b.payments : null,
        customer_name: b.customer_name ?? null,
        cashier_id: b.cashier_id ?? null,
        cashier_name: b.cashier_name ?? null,
        document_type: b.document_type ?? 'ticket',
        issued_at: b.issued_at ?? new Date().toISOString(),
      }).select().single();
      if (!res.error) { inv = res.data; break; }
      invErr = res.error;
      const isDup = (res.error as any)?.code === '23505' || /duplicate key/i.test(res.error.message ?? '');
      if (!isDup) break;
      finalNumber = await nextInvoiceNumber(tenantId, attempt + 1);
    }
    if (!inv) throw new Error(invErr?.message ?? 'No se pudo crear la factura');

    await db.from('invoice_items').insert(items.map((it: any) => ({
      invoice_id: inv.id, product_id: it.product_id, quantity: it.quantity,
      unit_price: it.unit_price, discount_percent: it.discount_percent ?? 0,
      discount_amount: it.discount_amount ?? 0, subtotal: it.subtotal,
    })));

    // Descontar del stock del CAMIÓN (no del global).
    for (const it of items) {
      const cur = stockMap.get(it.product_id) ?? 0;
      await db.from('warehouse_stock').upsert(
        { warehouse_id: truckId, product_id: it.product_id, quantity: cur - Number(it.quantity) },
        { onConflict: 'warehouse_id,product_id' });
    }

    if (b.stop_id) await db.from('route_stops').update({ status: 'visited' }).eq('id', b.stop_id).eq('tenant_id', tenantId);

    // Venta a CRÉDITO en ruta → cuenta por cobrar.
    if (b.payment_method === 'credit') {
      try {
        const due = new Date(); due.setDate(due.getDate() + 30);
        await createReceivable(tenantId, {
          customer_id: b.customer_id ?? null, customer_name: b.customer_name ?? null,
          invoice_id: inv.id, invoice_number: inv.invoice_number,
          total_amount: Number(inv.total ?? 0), due_date: due.toISOString().slice(0, 10),
          source: 'distribution',
        });
      } catch (e: any) { console.warn('[routing sale] CxC:', e?.message); }
    }

    return ok(c, inv, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/order — PREVENTA: guarda un pedido a entregar (no descuenta stock).
routing.post('/:id/order', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const b = await c.req.json();
    const items: any[] = Array.isArray(b.items) ? b.items : [];
    if (items.length === 0) return fail(c, 'Sin productos', 422);

    // Total del pedido: si no viene, se calcula desde los ítems (no guardar 0).
    const itemsTotal = items.reduce((s: number, it: any) => s + Number(it.unit_price ?? 0) * Number(it.quantity ?? 0), 0);
    const orderTotal = Number(b.total) > 0 ? Number(b.total) : itemsTotal;
    const { data: order, error } = await db.from('route_orders').insert({
      tenant_id: tenantId, route_id: id,
      customer_id: b.customer_id ?? null, customer_name: b.customer_name ?? null,
      total: orderTotal, notes: b.notes ?? null,
    }).select().single();
    if (error) throw new Error(error.message);

    await db.from('route_order_items').insert(items.map((it: any) => ({
      order_id: order.id, product_id: it.product_id, quantity: it.quantity, unit_price: it.unit_price ?? 0,
    })));

    if (b.stop_id) await db.from('route_stops').update({ status: 'visited' }).eq('id', b.stop_id).eq('tenant_id', tenantId);
    return ok(c, order, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id/sales — facturas (ventas) de la ruta, para poder anularlas.
routing.get('/:id/sales', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data: invs } = await db.from('invoices')
      .select('id, invoice_number, total, status, payment_method, customer_name, issued_at, items:invoice_items(product_id, quantity, unit_price)')
      .eq('tenant_id', tenantId).eq('route_id', id).order('issued_at', { ascending: false });
    const pids = [...new Set((invs ?? []).flatMap((i: any) => (i.items ?? []).map((it: any) => it.product_id)))];
    const nameMap = new Map<string, string>();
    if (pids.length > 0) {
      const { data: prods } = await db.from('products').select('id, name').in('id', pids as string[]);
      for (const p of prods ?? []) nameMap.set((p as any).id, (p as any).name);
    }
    const out = (invs ?? []).map((i: any) => ({
      ...i, items: (i.items ?? []).map((it: any) => ({ ...it, product_name: nameMap.get(it.product_id) ?? 'Producto' })),
    }));
    return ok(c, out);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /void-sale/:invoiceId — anula una factura de ruta y DEVUELVE el stock al camión.
routing.post('/void-sale/:invoiceId', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { invoiceId } = c.req.param();

    const { data: inv } = await db.from('invoices')
      .select('id, status, route_id, payment_method').eq('id', invoiceId).eq('tenant_id', tenantId).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    if ((inv as any).status === 'cancelled') return fail(c, 'La factura ya está anulada', 409);

    // Camión de la ruta.
    let truckId: string | null = null;
    if ((inv as any).route_id) {
      const { data: route } = await db.from('routes')
        .select('warehouse_id').eq('id', (inv as any).route_id).eq('tenant_id', tenantId).maybeSingle();
      truckId = (route as any)?.warehouse_id ?? null;
    }

    // Devolver el stock al camión.
    const { data: items } = await db.from('invoice_items')
      .select('product_id, quantity').eq('invoice_id', invoiceId);
    if (truckId) {
      for (const it of (items ?? []) as any[]) {
        const { data: row } = await db.from('warehouse_stock')
          .select('quantity').eq('warehouse_id', truckId).eq('product_id', it.product_id).maybeSingle();
        await db.from('warehouse_stock').upsert(
          { warehouse_id: truckId, product_id: it.product_id, quantity: Number(row?.quantity ?? 0) + Number(it.quantity) },
          { onConflict: 'warehouse_id,product_id' });
      }
    }

    // Marcar anulada.
    await db.from('invoices').update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', invoiceId).eq('tenant_id', tenantId);

    // Si era a crédito, anular la cuenta por cobrar ligada.
    if ((inv as any).payment_method === 'credit') {
      await db.from('accounts_receivable').delete().eq('invoice_id', invoiceId).eq('tenant_id', tenantId);
    }

    return ok(c, { ok: true, returned_items: (items ?? []).length });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id/orders — lista de pedidos por entregar (preventa).
routing.get('/:id/orders', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data: orders } = await db.from('route_orders')
      .select('*, customer:customers(id, name, address, phone), items:route_order_items(product_id, quantity, unit_price)')
      .eq('route_id', id).eq('tenant_id', tenantId).order('created_at', { ascending: true });
    // Nombres de producto
    const pids = [...new Set((orders ?? []).flatMap((o: any) => (o.items ?? []).map((it: any) => it.product_id)))];
    const nameMap = new Map<string, string>();
    if (pids.length > 0) {
      const { data: prods } = await db.from('products').select('id, name').in('id', pids as string[]);
      for (const p of prods ?? []) nameMap.set((p as any).id, (p as any).name);
    }
    const out = (orders ?? []).map((o: any) => ({
      ...o, items: (o.items ?? []).map((it: any) => ({ ...it, product_name: nameMap.get(it.product_id) ?? 'Producto' })),
    }));
    return ok(c, out);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /order/:orderId/deliver — entregar pedido: registra el método de pago,
// genera la factura (route_id, sin caja chica), descuenta el stock del camión y
// devuelve la factura para imprimirla.
// body: { payment_method?: 'cash'|'card'|'sinpe', issued_at? }
routing.post('/order/:orderId/deliver', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { orderId } = c.req.param();
    const b = await c.req.json().catch(() => ({}));
    const mixedPayments = Array.isArray(b.payments) && b.payments.length > 1 ? b.payments : null;
    const paymentMethod = mixedPayments ? 'mixed' : (b.payment_method ?? 'cash');

    // Cargar el pedido + items + datos de la ruta.
    const { data: order } = await db.from('route_orders')
      .select('*, items:route_order_items(product_id, quantity, unit_price)')
      .eq('id', orderId).eq('tenant_id', tenantId).maybeSingle();
    if (!order) return fail(c, 'Pedido no encontrado', 404);
    if ((order as any).status === 'delivered') return fail(c, 'El pedido ya fue entregado', 409);

    const routeId = (order as any).route_id;
    const { data: route } = await db.from('routes')
      .select('warehouse_id').eq('id', routeId).eq('tenant_id', tenantId).maybeSingle();
    const truckId = (route as any)?.warehouse_id ?? null;

    const items: any[] = (order as any).items ?? [];
    const subtotal = items.reduce((s, it) => s + Number(it.unit_price) * Number(it.quantity), 0);
    // Total del pedido; si viene en 0/vacío, se recalcula desde los ítems (evita
    // facturas en ₡0 cuando el pedido se guardó sin total).
    const orderTotal = Number((order as any).total ?? 0);
    const total = orderTotal > 0 ? orderTotal : subtotal;

    // Crear factura con consecutivo único.
    let inv: any = null, invErr: any = null;
    let finalNumber = await nextInvoiceNumber(tenantId);
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await db.from('invoices').insert({
        tenant_id: tenantId,
        cash_session_id: null,
        route_id: routeId,
        invoice_number: finalNumber,
        subtotal,
        discount_amount: 0,
        tax_amount: 0,
        total,
        payment_method: paymentMethod,
        payments: mixedPayments,
        customer_name: (order as any).customer_name ?? null,
        document_type: 'ticket',
        issued_at: b.issued_at ?? new Date().toISOString(),
      }).select().single();
      if (!res.error) { inv = res.data; break; }
      invErr = res.error;
      const isDup = (res.error as any)?.code === '23505' || /duplicate key/i.test(res.error.message ?? '');
      if (!isDup) break;
      finalNumber = await nextInvoiceNumber(tenantId, attempt + 1);
    }
    if (!inv) throw new Error(invErr?.message ?? 'No se pudo crear la factura');

    if (items.length > 0) {
      await db.from('invoice_items').insert(items.map((it: any) => ({
        invoice_id: inv.id, product_id: it.product_id, quantity: it.quantity,
        unit_price: it.unit_price, discount_percent: 0, discount_amount: 0,
        subtotal: Number(it.unit_price) * Number(it.quantity),
      })));
    }

    // Descontar del stock del camión (si la ruta tiene camión).
    if (truckId) {
      const pids = items.map((it: any) => it.product_id);
      const { data: stockRows } = await db.from('warehouse_stock')
        .select('product_id, quantity').eq('warehouse_id', truckId).in('product_id', pids);
      const stockMap = new Map((stockRows ?? []).map((s: any) => [s.product_id, Number(s.quantity)]));
      for (const it of items) {
        const cur = stockMap.get(it.product_id) ?? 0;
        await db.from('warehouse_stock').upsert(
          { warehouse_id: truckId, product_id: it.product_id, quantity: cur - Number(it.quantity) },
          { onConflict: 'warehouse_id,product_id' });
      }
    }

    // Marcar entregado + método de pago (resiliente si falta la columna).
    const upd = await db.from('route_orders')
      .update({ status: 'delivered', delivered_at: new Date().toISOString(), payment_method: paymentMethod })
      .eq('id', orderId).eq('tenant_id', tenantId);
    if (upd.error) {
      await db.from('route_orders')
        .update({ status: 'delivered', delivered_at: new Date().toISOString() })
        .eq('id', orderId).eq('tenant_id', tenantId);
    }

    // Entrega a CRÉDITO → cuenta por cobrar.
    if (paymentMethod === 'credit') {
      try {
        const due = new Date(); due.setDate(due.getDate() + 30);
        await createReceivable(tenantId, {
          customer_id: (order as any).customer_id ?? null,
          customer_name: (order as any).customer_name ?? null,
          invoice_id: inv.id, invoice_number: inv.invoice_number,
          total_amount: Number(inv.total ?? 0), due_date: due.toISOString().slice(0, 10),
          source: 'distribution',
        });
      } catch (e: any) { console.warn('[routing deliver] CxC:', e?.message); }
    }

    return ok(c, inv);
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

    // 1) Devolver el sobrante del camión al INVENTARIO DEL SISTEMA (products.stock_quantity).
    let returnedItems: Array<{ product_id: string; quantity: number }> = [];
    const returnedDetail: Array<{ name: string; quantity: number }> = [];
    {
      const { data: stock } = await db.from('warehouse_stock')
        .select('product_id, quantity').eq('warehouse_id', truckId);
      returnedItems = (stock ?? []).filter((s: any) => Number(s.quantity) > 0)
        .map((s: any) => ({ product_id: s.product_id, quantity: Number(s.quantity) }));

      for (const it of returnedItems) {
        const { data: prod } = await db.from('products')
          .select('name, stock_quantity, tracks_stock').eq('id', it.product_id).eq('tenant_id', tenantId).maybeSingle();
        if (prod && (prod as any).tracks_stock !== false) {
          await db.from('products').update({
            stock_quantity: Number((prod as any).stock_quantity ?? 0) + it.quantity,
            updated_at: new Date().toISOString(),
          }).eq('id', it.product_id);
        }
        returnedDetail.push({ name: (prod as any)?.name ?? 'Producto', quantity: it.quantity });
        await db.from('warehouse_stock').upsert(
          { warehouse_id: truckId, product_id: it.product_id, quantity: 0 },
          { onConflict: 'warehouse_id,product_id' });
      }
    }
    void userId;

    // 2) Resumen de ventas/anulaciones + desglose por método.
    const { data: invs } = await db.from('invoices')
      .select('total, status, payment_method, payments').eq('tenant_id', tenantId).eq('route_id', id);
    const sales = (invs ?? []).filter((i: any) => i.status !== 'cancelled');
    const voids = (invs ?? []).filter((i: any) => i.status === 'cancelled');
    const salesTotal = sales.reduce((s: number, i: any) => s + Number(i.total ?? 0), 0);
    const byMethod = { cash: 0, card: 0, sinpe: 0, credit: 0 };
    const addMethod = (m: string, amt: number) => {
      if (m === 'card' || m === 'sinpe' || m === 'credit') byMethod[m] += amt;
      else byMethod.cash += amt;
    };
    for (const i of sales) {
      // Pago MIXTO: repartir por cada split (antes se contaba todo como efectivo,
      // así la parte de tarjeta/SINPE/crédito del mixto no se contabilizaba).
      if (i.payment_method === 'mixed' && Array.isArray(i.payments) && i.payments.length > 0) {
        for (const p of i.payments) addMethod(p.method ?? 'cash', Number(p.amount ?? 0));
        continue;
      }
      addMethod(i.payment_method ?? 'cash', Number(i.total ?? 0));
    }

    returnedDetail.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const summary = {
      route_id: id,
      sales_count: sales.length,
      sales_total: salesTotal,
      voids_count: voids.length,
      returned_items: returnedItems.length,
      returned: returnedDetail,
      by_method: byMethod,
    };

    // 3) Cerrar la ruta y GUARDAR el resumen para poder reimprimirlo luego.
    //    El update de close_summary es best-effort (por si la columna aún no existe).
    await db.from('routes').update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId);
    try {
      await db.from('routes').update({ close_summary: summary }).eq('id', id).eq('tenant_id', tenantId);
    } catch { /* columna close_summary no existe todavía */ }

    return ok(c, summary);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id/close-summary — resumen de una ruta cerrada, para REIMPRIMIR el cierre.
// Usa el resumen guardado; si no existe, recalcula ventas por método (sin el
// detalle de sobrante, que ya volvió al inventario al cerrar).
routing.get('/:id/close-summary', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data: route } = await db.from('routes')
      .select('id, route_date, close_summary, loaded_summary, warehouse:warehouses!routes_warehouse_id_fkey(name)')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!route) return fail(c, 'Ruta no encontrada', 404);

    const truck = (route as any).warehouse?.name;
    const stored = (route as any).close_summary;

    // Recomputar ventas por método desde las facturas (siempre disponibles).
    const { data: invs } = await db.from('invoices')
      .select('id, total, status, payment_method').eq('tenant_id', tenantId).eq('route_id', id);
    const sales = (invs ?? []).filter((i: any) => i.status !== 'cancelled');
    const voids = (invs ?? []).filter((i: any) => i.status === 'cancelled');
    const byMethod = { cash: 0, card: 0, sinpe: 0, credit: 0 };
    for (const i of sales) {
      const m = (i.payment_method ?? 'cash') as 'cash' | 'card' | 'sinpe' | 'credit';
      if (m === 'card' || m === 'sinpe' || m === 'credit') byMethod[m] += Number(i.total ?? 0);
      else byMethod.cash += Number(i.total ?? 0);
    }

    // Sobrante: 1) el guardado en close_summary; si no, 2) reconstruir cargado − vendido.
    let returned: Array<{ name: string; quantity: number }> = stored?.returned ?? [];
    if (returned.length === 0) {
      const loaded: Record<string, number> = (route as any).loaded_summary ?? {};
      if (Object.keys(loaded).length > 0) {
        // Vendido por producto (facturas no anuladas de la ruta).
        const saleIds = sales.map((i: any) => i.id);
        const sold: Record<string, number> = {};
        if (saleIds.length > 0) {
          const { data: lines } = await db.from('invoice_items')
            .select('product_id, quantity, invoice_id').in('invoice_id', saleIds);
          for (const l of (lines ?? []) as any[]) sold[l.product_id] = Number(sold[l.product_id] ?? 0) + Number(l.quantity);
        }
        const leftoverIds = Object.keys(loaded).filter(pid => Number(loaded[pid]) - Number(sold[pid] ?? 0) > 0.0001);
        const nameMap = new Map<string, string>();
        if (leftoverIds.length > 0) {
          const { data: prods } = await db.from('products').select('id, name').in('id', leftoverIds);
          for (const p of prods ?? []) nameMap.set((p as any).id, (p as any).name);
        }
        returned = leftoverIds.map(pid => ({
          name: nameMap.get(pid) ?? 'Producto',
          quantity: Math.round((Number(loaded[pid]) - Number(sold[pid] ?? 0)) * 1000) / 1000,
        }));
      }
    }
    returned = [...returned].sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));

    return ok(c, {
      route_id: id, truck, route_date: (route as any).route_date,
      sales_count: stored?.sales_count ?? sales.length,
      sales_total: stored?.sales_total ?? sales.reduce((s: number, i: any) => s + Number(i.total ?? 0), 0),
      voids_count: stored?.voids_count ?? voids.length,
      returned_items: returned.length,
      returned,
      by_method: stored?.by_method ?? byMethod,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default routing;
