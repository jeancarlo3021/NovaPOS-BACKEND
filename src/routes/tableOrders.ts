import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * Cuentas por MESA (restaurante).
 *
 * Flujo: el mesero abre una cuenta en la mesa → le va agregando rondas de consumo
 * → al final se cobra y la cuenta se cierra, ligada a la factura.
 *
 * El cobro NO se hace acá: se hace en el POS con el flujo normal (que ya sabe de
 * IVA, medios de pago, FE e impresión). Este módulo solo guarda el consumo y, al
 * cobrar, marca la cuenta como cerrada (POST /:id/close con el invoice_id).
 */
const tableOrders = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const ItemSchema = z.object({
  product_id:       z.string().uuid().optional().nullable(),
  product_name:     z.string().min(1),
  quantity:         z.number().positive(),
  unit_price:       z.number().nonnegative(),
  discount_percent: z.number().min(0).max(100).optional(),
  subtotal:         z.number().nonnegative(),
  notes:            z.string().optional().nullable(),
});

/** Suma el consumo de una cuenta a partir de sus líneas. */
function totalOf(items: any[]): number {
  return Math.round(items.reduce((s, it) => s + Number(it.subtotal ?? 0), 0) * 100) / 100;
}

// GET / — cuentas ABIERTAS (para pintar el mapa: qué mesa está ocupada y por cuánto).
// ?status=closed&from=&to= para el histórico.
tableOrders.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status') || 'open';
    let q = db.from('table_orders')
      .select('*, table_order_items(*)')
      .eq('tenant_id', tenantId).eq('status', status)
      .order('opened_at', { ascending: false }).limit(500);
    const from = c.req.query('from'); const to = c.req.query('to');
    if (from) q = q.gte('opened_at', from);
    if (to)   q = q.lte('opened_at', to);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data ?? []).map((o: any) => ({
      ...o,
      items: o.table_order_items ?? [],
      total: totalOf(o.table_order_items ?? []),
      item_count: (o.table_order_items ?? []).length,
    }));
    return ok(c, rows);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ─────────────────────────────────────────────────────────────────────────────
// BILLS — el modelo del módulo Restaurante (/billing), sobre la MISMA tabla.
//
// /billing manejaba sus cuentas en el localStorage del navegador: no se veían
// entre dispositivos y se perdían al limpiar el caché. Estos endpoints le dan el
// mismo modelo (una cuenta puede agrupar varias mesas/sillas, tiene mesero,
// delivery y color) pero guardado en la base.
// ─────────────────────────────────────────────────────────────────────────────

const BillItemSchema = z.object({
  id:           z.string().optional(),
  product_id:   z.string().uuid().optional().nullable(),
  category_id:  z.string().uuid().optional().nullable(),
  name:         z.string().min(1),
  unit_price:   z.number(),
  quantity:     z.number(),
  modifiers:    z.array(z.object({
    group: z.string(), name: z.string(), price_delta: z.number(),
  })).optional().nullable(),
  notes:        z.string().optional().nullable(),
});

const BillSchema = z.object({
  id:               z.string().optional(),
  spots:            z.array(z.object({ id: z.string(), kind: z.string() })).min(1),
  customer_name:    z.string().optional().nullable(),
  notes:            z.string().optional().nullable(),
  items:            z.array(BillItemSchema),
  opened_at:        z.string().optional(),
  closed_at:        z.string().optional().nullable(),
  status:           z.enum(['open', 'paid', 'cancelled']),
  payment_method:   z.string().optional().nullable(),
  responsible_name: z.string().optional().nullable(),
  waiter_name:      z.string().optional().nullable(),
  is_delivery:      z.boolean().optional(),
  color:            z.string(),
});

/** Total de una línea: (base + modificadores) × cantidad. */
const lineTotal = (it: any) => {
  const mods = (it.modifiers ?? []).reduce((s: number, m: any) => s + Number(m.price_delta ?? 0), 0);
  return Math.round((Number(it.unit_price ?? 0) + mods) * Number(it.quantity ?? 0) * 100) / 100;
};

/** Fila de la base → el `Bill` que espera el frontend. */
function rowToBill(o: any) {
  const items = (o.table_order_items ?? []).map((it: any) => ({
    id: it.client_id ?? it.id,
    product_id: it.product_id ?? undefined,
    category_id: it.category_id ?? undefined,
    name: it.product_name,
    unit_price: Number(it.unit_price ?? 0),
    quantity: Number(it.quantity ?? 0),
    modifiers: it.modifiers ?? undefined,
    notes: it.notes ?? undefined,
  }));
  return {
    id: o.id,
    spots: o.spots ?? (o.table_id ? [{ id: o.table_id, kind: 'table' }] : []),
    customer_name: o.customer_name ?? undefined,
    notes: o.notes ?? undefined,
    items,
    opened_at: o.opened_at,
    closed_at: o.closed_at ?? undefined,
    status: o.status,
    payment_method: o.payment_method ?? undefined,
    responsible_name: o.responsible_name ?? undefined,
    waiter_name: o.waiter_name ?? undefined,
    is_delivery: !!o.is_delivery,
    color: o.color ?? '#3b82f6',
  };
}

// GET /bills — cuentas del restaurante. Por defecto solo las ABIERTAS (es lo que
// el mapa necesita); ?status=all trae también las cobradas del día.
tableOrders.get('/bills', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status') ?? 'open';
    let q = db.from('table_orders')
      .select('*, table_order_items(*)')
      .eq('tenant_id', tenantId).order('opened_at', { ascending: false }).limit(500);
    if (status !== 'all') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ok(c, (data ?? []).map(rowToBill));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /bills/:id — crea o reemplaza una cuenta completa. El frontend maneja el
// bill entero en memoria, así que guardarlo completo evita tener que trocear cada
// cambio en llamadas distintas (agregar línea, cambiar cantidad, dividir…).
tableOrders.put('/bills/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const parsed = BillSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const b = parsed.data;

    const row = {
      tenant_id: tenantId,
      table_id: b.spots[0]?.id ?? id,     // principal, para el índice de una-mesa-una-cuenta
      spots: b.spots,
      customer_name: b.customer_name ?? null,
      notes: b.notes ?? null,
      status: b.status,
      payment_method: b.payment_method ?? null,
      responsible_name: b.responsible_name ?? null,
      waiter_name: b.waiter_name ?? null,
      is_delivery: !!b.is_delivery,
      color: b.color,
      opened_at: b.opened_at ?? new Date().toISOString(),
      closed_at: b.closed_at ?? null,
      opened_by: userId,
      updated_at: new Date().toISOString(),
    };

    const { data: exists } = await db.from('table_orders')
      .select('id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();

    if (exists) {
      const { error } = await db.from('table_orders').update(row).eq('id', id).eq('tenant_id', tenantId);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await db.from('table_orders').insert({ ...row, id });
      if (error) throw new Error(error.message);
    }

    // Las líneas se reemplazan enteras: es lo que hace consistente el guardado
    // completo (una línea borrada en el cliente desaparece acá también).
    await db.from('table_order_items').delete().eq('order_id', id);
    if (b.items.length > 0) {
      const rows = b.items.map((it, i) => ({
        order_id: id,
        client_id: it.id ?? null,
        product_id: it.product_id ?? null,
        category_id: it.category_id ?? null,
        product_name: it.name,
        quantity: it.quantity,
        unit_price: it.unit_price,
        subtotal: lineTotal(it),
        modifiers: it.modifiers ?? null,
        notes: it.notes ?? null,
        course: i + 1,
      }));
      const { error } = await db.from('table_order_items').insert(rows);
      if (error) throw new Error(error.message);
    }

    const { data: saved } = await db.from('table_orders')
      .select('*, table_order_items(*)').eq('id', id).maybeSingle();
    return ok(c, saved ? rowToBill(saved) : null);
  } catch (err: any) { return fail(c, err.message, 500); }
});

tableOrders.delete('/bills/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { error } = await db.from('table_orders')
      .delete().eq('id', c.req.param('id')).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id — una cuenta con su detalle.
tableOrders.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('table_orders')
      .select('*, table_order_items(*)')
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Cuenta no encontrada', 404);
    const items = (data as any).table_order_items ?? [];
    return ok(c, { ...data, items, total: totalOf(items) });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST / — abre una cuenta en una mesa. Si ya hay una abierta, la devuelve (no
// falla): dos meseros tocando la misma mesa deben caer en la MISMA cuenta.
// body: { table_id, table_label?, guests?, notes?, items?: [] }
tableOrders.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({} as any));
    const tableId = String(body?.table_id ?? '').trim();
    if (!tableId) return fail(c, 'Falta la mesa (table_id)', 422);

    const { data: existing } = await db.from('table_orders')
      .select('*, table_order_items(*)')
      .eq('tenant_id', tenantId).eq('table_id', tableId).eq('status', 'open').maybeSingle();
    if (existing) {
      const items = (existing as any).table_order_items ?? [];
      return ok(c, { ...existing, items, total: totalOf(items), already_open: true });
    }

    const { data: created, error } = await db.from('table_orders').insert({
      tenant_id: tenantId,
      table_id: tableId,
      table_label: body?.table_label ?? null,
      guests: Number(body?.guests) > 0 ? Number(body.guests) : 1,
      notes: body?.notes ?? null,
      opened_by: userId,
    }).select('*').single();
    if (error) throw new Error(error.message);

    // Se puede abrir la cuenta ya con la primera ronda.
    const raw = Array.isArray(body?.items) ? body.items : [];
    if (raw.length > 0) {
      const parsed = z.array(ItemSchema).safeParse(raw);
      if (!parsed.success) return fail(c, parsed.error.message, 422);
      const rows = parsed.data.map(it => ({ ...it, order_id: (created as any).id, course: 1 }));
      const { error: iErr } = await db.from('table_order_items').insert(rows);
      if (iErr) throw new Error(iErr.message);
    }
    return ok(c, { ...(created as any), items: raw, total: totalOf(raw) }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/items — agrega una RONDA a la cuenta. body: { items: [...] }
tableOrders.post('/:id/items', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));
    const parsed = z.array(ItemSchema).min(1).safeParse(body?.items);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data: order } = await db.from('table_orders')
      .select('id, status').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!order) return fail(c, 'Cuenta no encontrada', 404);
    if ((order as any).status !== 'open') return fail(c, 'La cuenta ya está cerrada', 409);

    // Número de ronda: la siguiente a la última registrada.
    const { data: prev } = await db.from('table_order_items')
      .select('course').eq('order_id', id).order('course', { ascending: false }).limit(1);
    const course = Number((prev ?? [])[0]?.course ?? 0) + 1;

    const rows = parsed.data.map(it => ({ ...it, order_id: id, course }));
    const { data: inserted, error } = await db.from('table_order_items').insert(rows).select('*');
    if (error) throw new Error(error.message);
    await db.from('table_orders').update({ updated_at: new Date().toISOString() }).eq('id', id);
    return ok(c, { course, items: inserted ?? [] }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// DELETE /:id/items/:itemId — quita una línea (se equivocó el mesero).
tableOrders.delete('/:id/items/:itemId', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id, itemId } = c.req.param();
    const { data: order } = await db.from('table_orders')
      .select('id, status').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!order) return fail(c, 'Cuenta no encontrada', 404);
    if ((order as any).status !== 'open') return fail(c, 'La cuenta ya está cerrada', 409);
    const { error } = await db.from('table_order_items').delete().eq('id', itemId).eq('order_id', id);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PATCH /:id — comensales, notas o MOVER la cuenta a otra mesa.
// body: { guests?, notes?, table_id?, table_label? }
tableOrders.patch('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));
    const patch: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body?.guests != null) patch.guests = Math.max(1, Number(body.guests) || 1);
    if (body?.notes !== undefined) patch.notes = body.notes;
    if (body?.table_id) {
      // Mover a otra mesa: la destino no puede tener ya una cuenta abierta.
      const dest = String(body.table_id).trim();
      const { data: busy } = await db.from('table_orders')
        .select('id').eq('tenant_id', tenantId).eq('table_id', dest)
        .eq('status', 'open').neq('id', id).maybeSingle();
      if (busy) return fail(c, 'Esa mesa ya tiene una cuenta abierta. Cerrala o juntá las cuentas.', 409);
      patch.table_id = dest;
      if (body?.table_label !== undefined) patch.table_label = body.table_label;
    }
    const { data, error } = await db.from('table_orders')
      .update(patch).eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/close — cierra la cuenta al cobrar. body: { invoice_id? }
// El cobro real lo hace el POS; acá solo se marca cerrada y se liga a la factura.
tableOrders.post('/:id/close', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));
    const { data, error } = await db.from('table_orders').update({
      status: 'closed',
      invoice_id: body?.invoice_id ?? null,
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId).eq('status', 'open').select('*').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'La cuenta no existe o ya estaba cerrada', 409);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/cancel — anula la cuenta sin cobrar (se fueron sin consumir, error…).
tableOrders.post('/:id/cancel', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('table_orders').update({
      status: 'cancelled', closed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', c.req.param('id')).eq('tenant_id', tenantId).eq('status', 'open').select('*').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'La cuenta no existe o ya estaba cerrada', 409);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default tableOrders;
