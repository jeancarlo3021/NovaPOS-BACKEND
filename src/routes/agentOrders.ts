import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { findAgendaConflict } from '../services/agendaConflicts.js';

/**
 * Pedidos del agente hacia CAJA.
 *
 * El agente arma el pedido y lo envía; le aparece al cajero en su bandeja. El
 * cajero lo TOMA (queda reservado para él, para que dos cajeros no cobren el
 * mismo pedido), lo carga en el POS y lo cobra con el flujo normal. Al cobrarse
 * se marca `charged`, se liga a la factura y se calcula la comisión del agente.
 */
const agentOrders = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const ItemSchema = z.object({
  product_id:   z.string().uuid().optional().nullable(),
  product_name: z.string().min(1),
  quantity:     z.number().positive(),
  unit_price:   z.number().nonnegative(),
  subtotal:     z.number().nonnegative(),
  notes:        z.string().optional().nullable(),
});

const totalOf = (items: any[]) =>
  Math.round(items.reduce((s, it) => s + Number(it.subtotal ?? 0), 0) * 100) / 100;

/** Consecutivo legible del pedido (P-000001). */
async function nextNumber(tenantId: string): Promise<string> {
  const { data } = await db.from('agent_orders')
    .select('number').eq('tenant_id', tenantId)
    .order('created_at', { ascending: false }).limit(1);
  const last = String((data ?? [])[0]?.number ?? '');
  const n = parseInt(last.replace(/\D/g, ''), 10);
  return `P-${String((Number.isFinite(n) ? n : 0) + 1).padStart(6, '0')}`;
}

// GET /me — agente vinculado al usuario que está logueado. Así el pedido sale a
// su nombre sin que tenga que elegirse a sí mismo en una lista.
/** Hoy en Costa Rica (YYYY-MM-DD). El día del negocio no es el UTC. */
function crToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
}

agentOrders.get('/me', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');

    // 1) Vinculado explícitamente (lo normal cuando el agente se creó con usuario).
    const { data: linked } = await db.from('sales_agents')
      .select('id, name, commission_percent')
      .eq('tenant_id', tenantId).eq('user_id', userId).eq('is_active', true).maybeSingle();
    if (linked) return ok(c, linked);

    // 2) Sin vínculo: se busca por el nombre o el correo del usuario logueado y,
    //    si aparece, se VINCULA para que la próxima sea directa. Cubre los agentes
    //    creados antes de que existiera la creación de usuario, sin obligar a
    //    reconfigurarlos a mano.
    const { data: u } = await db.from('users')
      .select('full_name, email').eq('id', userId).maybeSingle();
    const fullName = String((u as any)?.full_name ?? '').trim();
    const email = String((u as any)?.email ?? '').trim().toLowerCase();
    if (!fullName && !email) return ok(c, null);

    const { data: candidates } = await db.from('sales_agents')
      .select('id, name, commission_percent, email, user_id')
      .eq('tenant_id', tenantId).eq('is_active', true);
    const match = (candidates ?? []).find((a: any) => {
      if (a.user_id) return false;                        // ya es de otro usuario
      if (email && String(a.email ?? '').toLowerCase() === email) return true;
      return !!fullName && String(a.name ?? '').trim().toLowerCase() === fullName.toLowerCase();
    });
    if (!match) return ok(c, null);

    try {
      await db.from('sales_agents')
        .update({ user_id: userId, updated_at: new Date().toISOString() })
        .eq('id', (match as any).id).eq('tenant_id', tenantId);
    } catch (e: any) { console.warn('[agent-orders/me] no se pudo vincular:', e?.message); }

    return ok(c, {
      id: (match as any).id,
      name: (match as any).name,
      commission_percent: (match as any).commission_percent,
      auto_linked: true,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /?status=pending — bandeja del cajero. Sin filtro, los pendientes.
agentOrders.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status') || 'pending';
    const agentId = c.req.query('agent_id');
    let q = db.from('agent_orders')
      .select('*, agent_order_items(*)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }).limit(500);
    if (status !== 'all') q = q.eq('status', status);
    if (agentId) q = q.eq('agent_id', agentId);
    // Agenda: el cajero trabaja por día, no por "todo lo pendiente".
    const date = c.req.query('date');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const assignedTo = c.req.query('assigned_to');
    if (assignedTo === 'none') q = q.is('assigned_to', null);
    else if (assignedTo) q = q.eq('assigned_to', assignedTo);
    const zoneQ = c.req.query('zone');
    if (zoneQ) q = q.eq('customer_zone', zoneQ);
    if (date) q = q.eq('scheduled_date', date);
    else {
      if (from) q = q.gte('scheduled_date', from);
      if (to) q = q.lte('scheduled_date', to);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ok(c, (data ?? []).map((o: any) => ({
      ...o, items: o.agent_order_items ?? [], item_count: (o.agent_order_items ?? []).length,
    })));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /agenda?from=&to= — resumen por día para pintar el calendario del cajero.
agentOrders.get('/agenda', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from') || crToday();
    const to = c.req.query('to') || from;
    const { data, error } = await db.from('agent_orders')
      .select('scheduled_date, scheduled_time, status, total, assigned_to, assigned_name, customer_zone')
      .eq('tenant_id', tenantId)
      .gte('scheduled_date', from).lte('scheduled_date', to)
      .neq('status', 'cancelled')
      .limit(2000);
    const assignee = c.req.query('assigned_to');
    if (error) throw new Error(error.message);
    const byDay: Record<string, { date: string; pending: number; charged: number; total: number; unassigned?: number; people?: string[]; first_time?: string | null; last_time?: string | null; zones?: string[] }> = {};
    for (const r of (data ?? []) as any[]) {
      const d = r.scheduled_date;
      if (!d) continue;
      if (assignee && r.assigned_to !== assignee) continue;
      byDay[d] ??= { date: d, pending: 0, charged: 0, total: 0, unassigned: 0, people: [], first_time: null, last_time: null, zones: [] };
      if (r.status === 'charged') byDay[d].charged++; else byDay[d].pending++;
      byDay[d].total += Number(r.total ?? 0);
      // Franja del día: la primera y la última hora con entrega. Es lo que se
      // necesita para saber de un vistazo si el día ya está cargado.
      const t = r.scheduled_time ? String(r.scheduled_time).slice(0, 5) : null;
      if (t) {
        const cur = byDay[d];
        if (!cur.first_time || t < cur.first_time) cur.first_time = t;
        if (!cur.last_time || t > cur.last_time) cur.last_time = t;
      }
      if (r.customer_zone && !byDay[d].zones!.includes(r.customer_zone)) byDay[d].zones!.push(r.customer_zone);
      if (!r.assigned_to) byDay[d].unassigned = (byDay[d].unassigned ?? 0) + 1;
      else if (r.assigned_name && !byDay[d].people!.includes(r.assigned_name)) byDay[d].people!.push(r.assigned_name);
    }
    return ok(c, Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/schedule — mover un pedido de día sin tocar sus líneas.
agentOrders.post('/:id/schedule', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));

    const { data: prev } = await db.from('agent_orders')
      .select('scheduled_date, scheduled_time, reschedule_log, assigned_to')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!prev) return fail(c, 'Pedido no encontrado', 404);

    const nextDate = body?.scheduled_date ?? (prev as any).scheduled_date;
    const nextTime = body?.scheduled_time === undefined
      ? (prev as any).scheduled_time : (body.scheduled_time || null);

    const clash = await findAgendaConflict({
      tenantId, assignedTo: (prev as any).assigned_to ?? null,
      date: nextDate, time: nextTime, ignoreOrderId: id,
    });
    if (clash) return fail(c, `Esa hora ya está ocupada. ${clash}`, 409);

    const patch: any = {
      scheduled_date: nextDate || null, scheduled_time: nextTime,
      // Ya tiene fecha nueva: la alerta de la agenda se apaga.
      needs_reschedule: false, reject_reason: null,
    };
    if (body?.scheduled_note !== undefined) patch.scheduled_note = body.scheduled_note ?? null;

    // Bitácora: si se movió el día o la hora, queda registro de quién y por qué.
    // Sin esto, "¿por qué no llegó el martes?" no tiene respuesta.
    const moved = nextDate !== (prev as any).scheduled_date || nextTime !== (prev as any).scheduled_time;
    if (moved) {
      const log = Array.isArray((prev as any).reschedule_log) ? (prev as any).reschedule_log : [];
      patch.reschedule_log = [...log, {
        from: (prev as any).scheduled_date, from_time: (prev as any).scheduled_time,
        to: nextDate, to_time: nextTime,
        at: new Date().toISOString(), by: userId ?? null,
        reason: body?.reason ?? null,
      }].slice(-50);
    }

    let { data, error } = await db.from('agent_orders').update(patch)
      .eq('id', id).eq('tenant_id', tenantId).select('*').single();
    // Resiliente: sin la migración 91 no existen hora ni bitácora, pero el día
    // sí se puede mover.
    if (error && /scheduled_time|reschedule_log|needs_reschedule|reject_reason/i.test(error.message)) {
      const retry = await db.from('agent_orders')
        .update({ scheduled_date: patch.scheduled_date, scheduled_note: patch.scheduled_note })
        .eq('id', id).eq('tenant_id', tenantId).select('*').single();
      data = retry.data; error = retry.error;
    }
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /:id/items — reemplaza las líneas del pedido y recalcula el total.
//
// El cliente puede no quedarse con todo lo que pidió, o negociar el precio en la
// puerta. Sin esto había que anular el pedido y rehacerlo en caja.
agentOrders.put('/:id/items', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));
    const parsed = z.array(ItemSchema).min(1).safeParse(body?.items);
    if (!parsed.success) return fail(c, 'El pedido no puede quedar sin líneas: ' + parsed.error.message, 422);

    const { data: order } = await db.from('agent_orders')
      .select('id, status').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!order) return fail(c, 'Pedido no encontrado', 404);
    // Ya facturado: cambiarlo acá dejaría el pedido y la factura diciendo cosas
    // distintas. Eso se arregla con nota de crédito, no editando el pedido.
    if ((order as any).status === 'charged') return fail(c, 'El pedido ya fue cobrado: usá una nota de crédito', 409);
    if ((order as any).status === 'cancelled') return fail(c, 'El pedido está anulado', 409);

    const { error: delErr } = await db.from('agent_order_items').delete().eq('order_id', id);
    if (delErr) throw new Error(delErr.message);

    const rows = parsed.data.map(it => ({ ...it, order_id: id }));
    const { error: insErr } = await db.from('agent_order_items').insert(rows);
    if (insErr) throw new Error(insErr.message);

    const { data: updated, error: upErr } = await db.from('agent_orders')
      .update({ total: totalOf(parsed.data) })
      .eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (upErr) throw new Error(upErr.message);

    return ok(c, { ...(updated as any), items: rows });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/place — corrige la zona o el lugar de entrega desde la agenda.
agentOrders.post('/:id/place', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({} as any));
    const patch: any = {};
    if (body?.customer_zone !== undefined) patch.customer_zone = body.customer_zone || null;
    if (body?.delivery_place !== undefined) patch.delivery_place = body.delivery_place || null;
    const { data, error } = await db.from('agent_orders').update(patch)
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/reject — "no se pudo entregar". No anula el pedido: lo deja
// pendiente y marcado para que la agenda pida fecha nueva.
agentOrders.post('/:id/reject', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));
    const reason = String(body?.reason ?? '').trim();
    if (!reason) return fail(c, 'Poné por qué no se pudo entregar', 422);

    const { data: prev } = await db.from('agent_orders')
      .select('status, reschedule_log').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!prev) return fail(c, 'Pedido no encontrado', 404);
    if ((prev as any).status === 'charged') return fail(c, 'El pedido ya fue cobrado', 409);

    const now = new Date().toISOString();
    const log = Array.isArray((prev as any).reschedule_log) ? (prev as any).reschedule_log : [];
    const patch: any = {
      needs_reschedule: true, reject_reason: reason, rejected_at: now,
      // Vuelve a la bandeja: si estaba tomado por un cajero, se libera.
      status: 'pending', taken_by: null, taken_at: null,
      reschedule_log: [...log, { at: now, by: userId ?? null, reason, to: null, from: null }].slice(-50),
    };
    let { data, error } = await db.from('agent_orders').update(patch)
      .eq('id', id).eq('tenant_id', tenantId).select('*').single();
    // Sin la migración 96 se registra igual en la bitácora, que es lo que no se
    // puede perder: el motivo.
    if (error && /needs_reschedule|reject_reason|rejected_at/i.test(error.message)) {
      const retry = await db.from('agent_orders')
        .update({ status: 'pending', taken_by: null, taken_at: null, reschedule_log: patch.reschedule_log })
        .eq('id', id).eq('tenant_id', tenantId).select('*').single();
      data = retry.data; error = retry.error;
    }
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/assign — responsable de la entrega. body: { assigned_to, assigned_name }
agentOrders.post('/:id/assign', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));

    if (body?.assigned_to) {
      const { data: cur } = await db.from('agent_orders')
        .select('scheduled_date, scheduled_time').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
      const clash = await findAgendaConflict({
        tenantId, assignedTo: body.assigned_to,
        date: (cur as any)?.scheduled_date, time: (cur as any)?.scheduled_time,
        ignoreOrderId: id,
      });
      if (clash) return fail(c, `No se puede asignar: esa persona ya está ocupada. ${clash}`, 409);
    }

    const { data, error } = await db.from('agent_orders').update({
      assigned_to: body?.assigned_to ?? null,
      assigned_name: body?.assigned_to ? (body?.assigned_name ?? null) : null,
      assigned_at: body?.assigned_to ? new Date().toISOString() : null,
    }).eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

agentOrders.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('agent_orders')
      .select('*, agent_order_items(*)')
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Pedido no encontrado', 404);
    return ok(c, { ...data, items: (data as any).agent_order_items ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST / — el agente ENVÍA el pedido a caja.
// body: { agent_id?, customer_id?, customer_name?, customer_phone?, notes?, items[] }
agentOrders.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({} as any));
    const parsed = z.array(ItemSchema).min(1).safeParse(body?.items);
    if (!parsed.success) return fail(c, 'El pedido no tiene líneas: ' + parsed.error.message, 422);

    // Nombre del agente como snapshot: el pedido tiene que seguir legible aunque
    // después se desactive o se le cambie el nombre.
    let agentName: string | null = body?.agent_name ?? null;
    if (body?.agent_id && !agentName) {
      const { data: a } = await db.from('sales_agents')
        .select('name').eq('id', body.agent_id).eq('tenant_id', tenantId).maybeSingle();
      agentName = (a as any)?.name ?? null;
    }

    // Una persona no puede tener dos cosas a la misma hora.
    const clash = await findAgendaConflict({
      tenantId, assignedTo: body?.assigned_to ?? null,
      date: body?.scheduled_date || crToday(), time: body?.scheduled_time ?? null,
    });
    if (clash) return fail(c, `Esa hora ya está ocupada. ${clash}`, 409);

    // Zona y lugar: si el pedido trae cliente y no se mandó el lugar a mano, se
    // copian de su ficha. Sin esto la agenda no dice a dónde hay que ir.
    let zone: string | null = body?.customer_zone ?? null;
    let place: string | null = body?.delivery_place ?? null;
    if (body?.customer_id && (!zone || !place)) {
      const { data: cust } = await db.from('customers')
        .select('zone, address').eq('id', body.customer_id).eq('tenant_id', tenantId).maybeSingle();
      zone ??= (cust as any)?.zone ?? null;
      place ??= (cust as any)?.address ?? null;
    }

    const { data: created, error } = await db.from('agent_orders').insert({
      tenant_id: tenantId,
      agent_id: body?.agent_id ?? null,
      agent_name: agentName,
      number: await nextNumber(tenantId),
      status: 'pending',
      customer_id: body?.customer_id ?? null,
      customer_name: body?.customer_name ?? null,
      customer_phone: body?.customer_phone ?? null,
      notes: body?.notes ?? null,
      // Tipo de comprobante que pidió el cliente. Lo elige el AGENTE, que es
      // quien habla con él; el cajero solo lo respeta al cobrar.
      document_type: ['ticket', 'tiquete_electronico', 'factura_electronica']
        .includes(String(body?.document_type)) ? body.document_type : 'ticket',
      // Día acordado con el cliente. Sin fecha, el pedido cae en la bandeja de
      // hoy y el cajero no distingue lo de esta tarde de lo del jueves.
      scheduled_date: body?.scheduled_date || crToday(),
      scheduled_note: body?.scheduled_note ?? null,
      scheduled_time: body?.scheduled_time || null,
      assigned_to: body?.assigned_to ?? null,
      assigned_name: body?.assigned_name ?? null,
      assigned_at: body?.assigned_to ? new Date().toISOString() : null,
      customer_zone: zone,
      delivery_place: place,
      proforma_id: body?.proforma_id ?? null,
      total: totalOf(parsed.data),
      created_by: userId,
    }).select('*').single();
    // Resiliente: si la migración 90 no corrió, se reintenta sin los campos de
    // agenda. El pedido vale más que su fecha.
    if (error && /scheduled_date|scheduled_note|proforma_id|scheduled_time|assigned_|customer_zone|delivery_place/i.test(error.message)) {
      const retry = await db.from('agent_orders').insert({
        tenant_id: tenantId, agent_id: body?.agent_id ?? null, agent_name: agentName,
        number: await nextNumber(tenantId), status: 'pending',
        customer_id: body?.customer_id ?? null, customer_name: body?.customer_name ?? null,
        customer_phone: body?.customer_phone ?? null, notes: body?.notes ?? null,
        document_type: ['ticket', 'tiquete_electronico', 'factura_electronica']
          .includes(String(body?.document_type)) ? body.document_type : 'ticket',
        total: totalOf(parsed.data), created_by: userId,
      }).select('*').single();
      if (!retry.error) {
        const rowsA = parsed.data.map(it => ({ ...it, order_id: (retry.data as any).id }));
        const { error: iA } = await db.from('agent_order_items').insert(rowsA);
        if (iA) throw new Error(iA.message);
        return ok(c, { ...(retry.data as any), items: rowsA }, 201);
      }
    }
    // Resiliente: si la migración 78 no corrió, se reintenta sin document_type.
    if (error && /document_type/i.test(error.message)) {
      const retry = await db.from('agent_orders').insert({
        tenant_id: tenantId, agent_id: body?.agent_id ?? null, agent_name: agentName,
        number: await nextNumber(tenantId), status: 'pending',
        customer_id: body?.customer_id ?? null, customer_name: body?.customer_name ?? null,
        customer_phone: body?.customer_phone ?? null, notes: body?.notes ?? null,
        total: totalOf(parsed.data), created_by: userId,
      }).select('*').single();
      if (retry.error) throw new Error(retry.error.message);
      const rows0 = parsed.data.map(it => ({ ...it, order_id: (retry.data as any).id }));
      const { error: i0 } = await db.from('agent_order_items').insert(rows0);
      if (i0) throw new Error(i0.message);
      return ok(c, { ...(retry.data as any), items: rows0 }, 201);
    }
    if (error) throw new Error(error.message);

    const rows = parsed.data.map(it => ({ ...it, order_id: (created as any).id }));
    const { error: iErr } = await db.from('agent_order_items').insert(rows);
    if (iErr) throw new Error(iErr.message);

    // Liga de vuelta: desde la proforma se puede ver en qué pedido terminó.
    if (body?.proforma_id) {
      await db.from('proformas').update({ agent_order_id: (created as any).id })
        .eq('id', body.proforma_id).eq('tenant_id', tenantId);
    }

    return ok(c, { ...(created as any), items: rows }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/take — el cajero lo reserva para cobrarlo. Evita que dos cajeros
// cobren el mismo pedido: solo pasa de 'pending' a 'taken' una vez.
agentOrders.post('/:id/take', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const { data, error } = await db.from('agent_orders').update({
      status: 'taken', taken_by: userId,
      taken_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', c.req.param('id')).eq('tenant_id', tenantId).eq('status', 'pending')
      .select('*, agent_order_items(*)').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Ese pedido ya lo tomó otro cajero (o fue anulado).', 409);
    return ok(c, { ...data, items: (data as any).agent_order_items ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/release — devuelve el pedido a la bandeja (el cajero no lo cobró).
agentOrders.post('/:id/release', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('agent_orders').update({
      status: 'pending', taken_by: null, taken_at: null, updated_at: new Date().toISOString(),
    }).eq('id', c.req.param('id')).eq('tenant_id', tenantId).eq('status', 'taken').select('*').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'El pedido no estaba tomado', 409);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/charge — cobrado. body: { invoice_id?, total? }
// Calcula la comisión con el % vigente del agente.
agentOrders.post('/:id/charge', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));

    const { data: order } = await db.from('agent_orders')
      .select('id, agent_id, total, status, proforma_id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!order) return fail(c, 'Pedido no encontrado', 404);
    if ((order as any).status === 'charged') return fail(c, 'El pedido ya fue cobrado', 409);

    const total = Number(body?.total ?? (order as any).total ?? 0);
    let commission = 0;
    if ((order as any).agent_id) {
      const { data: a } = await db.from('sales_agents')
        .select('commission_percent').eq('id', (order as any).agent_id).maybeSingle();
      const pct = Number((a as any)?.commission_percent ?? 0);
      commission = Math.round(total * (pct / 100) * 100) / 100;
    }

    // Si el pedido nació de una proforma, la proforma queda cerrada: no se
    // puede volver a convertir en venta lo que ya se cobró acá.
    if ((order as any).proforma_id) {
      await db.from('proformas').update({
        status: 'converted',
        converted_invoice: body?.invoice_id ?? null,
      }).eq('id', (order as any).proforma_id).eq('tenant_id', tenantId);
    }

    const { data, error } = await db.from('agent_orders').update({
      status: 'charged',
      invoice_id: body?.invoice_id ?? null,
      total,
      commission_amount: commission,
      charged_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);

    // Marcar el vendedor en la factura (para reportes aunque el pedido se borre).
    if (body?.invoice_id && (order as any).agent_id) {
      try {
        await db.from('invoices').update({ sales_agent_id: (order as any).agent_id })
          .eq('id', body.invoice_id).eq('tenant_id', tenantId);
      } catch { /* migración 77 sin correr: no es crítico */ }
    }
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

agentOrders.post('/:id/cancel', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('agent_orders').update({
      status: 'cancelled', updated_at: new Date().toISOString(),
    }).eq('id', c.req.param('id')).eq('tenant_id', tenantId)
      .in('status', ['pending', 'taken']).select('*').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'El pedido no se puede anular (ya fue cobrado)', 409);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default agentOrders;
