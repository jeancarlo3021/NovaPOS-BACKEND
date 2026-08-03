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
