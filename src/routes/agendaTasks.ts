import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { findAgendaConflict } from '../services/agendaConflicts.js';

/**
 * Tareas de agenda: mandados y trámites del día.
 * Ver migrations/94_agenda_tasks.sql
 */
const agendaTasks = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const PlaceSchema = z.object({
  name: z.string().min(1),
  address: z.string().optional().nullable(),
  done: z.boolean().optional().default(false),
});

const TaskSchema = z.object({
  title: z.string().min(1),
  notes: z.string().optional().nullable(),
  scheduled_date: z.string().min(8),
  scheduled_time: z.string().optional().nullable(),
  places: z.array(PlaceSchema).optional().default([]),
  photos: z.array(z.string()).optional().default([]),
  assigned_to: z.string().uuid().optional().nullable(),
  assigned_name: z.string().optional().nullable(),
});

/** Hoy en Costa Rica: el día del negocio no es el UTC. */
function crToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
}

// GET /?date= | ?from=&to= [&assigned_to=] [&status=]
agendaTasks.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    let q = db.from('agenda_tasks').select('*').eq('tenant_id', tenantId)
      .order('scheduled_date').order('scheduled_time', { nullsFirst: false }).limit(1000);

    const date = c.req.query('date');
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (date) q = q.eq('scheduled_date', date);
    else {
      if (from) q = q.gte('scheduled_date', from);
      if (to) q = q.lte('scheduled_date', to);
    }
    const assignee = c.req.query('assigned_to');
    if (assignee === 'none') q = q.is('assigned_to', null);
    else if (assignee) q = q.eq('assigned_to', assignee);
    const status = c.req.query('status');
    if (status && status !== 'all') q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

agendaTasks.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({} as any));
    const parsed = TaskSchema.safeParse({ ...body, scheduled_date: body?.scheduled_date || crToday() });
    if (!parsed.success) return fail(c, 'Datos incompletos: ' + parsed.error.message, 422);

    const clash = await findAgendaConflict({
      tenantId, assignedTo: parsed.data.assigned_to ?? null,
      date: parsed.data.scheduled_date, time: parsed.data.scheduled_time ?? null,
    });
    if (clash) return fail(c, `Esa hora ya está ocupada. ${clash}`, 409);

    const { data, error } = await db.from('agenda_tasks').insert({
      tenant_id: tenantId, ...parsed.data,
      scheduled_time: parsed.data.scheduled_time || null,
      created_by: userId,
    }).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

agendaTasks.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({} as any));
    const patch: any = { updated_at: new Date().toISOString() };
    for (const f of ['title', 'notes', 'places', 'photos', 'assigned_to', 'assigned_name', 'scheduled_time']) {
      if (body?.[f] !== undefined) patch[f] = body[f] === '' ? null : body[f];
    }
    if (body?.assigned_to !== undefined && !body.assigned_to) patch.assigned_name = null;

    if (body?.assigned_to !== undefined || body?.scheduled_time !== undefined) {
      const { data: cur } = await db.from('agenda_tasks')
        .select('scheduled_date, scheduled_time, assigned_to')
        .eq('id', c.req.param('id')).eq('tenant_id', tenantId).maybeSingle();
      const clash = await findAgendaConflict({
        tenantId,
        assignedTo: body?.assigned_to !== undefined ? body.assigned_to : (cur as any)?.assigned_to,
        date: (cur as any)?.scheduled_date,
        time: body?.scheduled_time !== undefined ? body.scheduled_time : (cur as any)?.scheduled_time,
        ignoreTaskId: c.req.param('id'),
      });
      if (clash) return fail(c, `Esa hora ya está ocupada. ${clash}`, 409);
    }

    const { data, error } = await db.from('agenda_tasks').update(patch)
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/status — realizado / pendiente / anulada.
agendaTasks.post('/:id/status', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({} as any));
    const status = String(body?.status ?? '');
    if (!['pending', 'done', 'cancelled'].includes(status)) {
      return fail(c, 'Estado inválido', 422);
    }
    const { data, error } = await db.from('agenda_tasks').update({
      status,
      // Al desmarcarla se limpia la firma: si no, queda diciendo que se hizo.
      done_at: status === 'done' ? new Date().toISOString() : null,
      done_by: status === 'done' ? userId : null,
      updated_at: new Date().toISOString(),
    }).eq('id', c.req.param('id')).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/reject — "no se pudo hacer". Queda pendiente y pidiendo fecha.
agendaTasks.post('/:id/reject', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));
    const reason = String(body?.reason ?? '').trim();
    if (!reason) return fail(c, 'Poné por qué no se pudo hacer', 422);

    const { data: prev } = await db.from('agenda_tasks')
      .select('reschedule_log').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!prev) return fail(c, 'Tarea no encontrada', 404);

    const now = new Date().toISOString();
    const log = Array.isArray((prev as any).reschedule_log) ? (prev as any).reschedule_log : [];
    const { data, error } = await db.from('agenda_tasks').update({
      needs_reschedule: true, reject_reason: reason, rejected_at: now,
      status: 'pending', done_at: null, done_by: null,
      reschedule_log: [...log, { at: now, by: userId ?? null, reason, to: null, from: null }].slice(-50),
      updated_at: now,
    }).eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/schedule — pasarla a otro día u hora, con bitácora.
agendaTasks.post('/:id/schedule', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));

    const { data: prev } = await db.from('agenda_tasks')
      .select('scheduled_date, scheduled_time, reschedule_log, assigned_to')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!prev) return fail(c, 'Tarea no encontrada', 404);

    const nextDate = body?.scheduled_date || (prev as any).scheduled_date;
    const nextTime = body?.scheduled_time === undefined
      ? (prev as any).scheduled_time : (body.scheduled_time || null);
    const clash = await findAgendaConflict({
      tenantId, assignedTo: (prev as any).assigned_to ?? null,
      date: nextDate, time: nextTime, ignoreTaskId: id,
    });
    if (clash) return fail(c, `Esa hora ya está ocupada. ${clash}`, 409);

    const log = Array.isArray((prev as any).reschedule_log) ? (prev as any).reschedule_log : [];

    const { data, error } = await db.from('agenda_tasks').update({
      scheduled_date: nextDate,
      scheduled_time: nextTime,
      // Se vuelve a poner pendiente: si se pasó de día, no está hecha.
      status: 'pending', done_at: null, done_by: null,
      // Ya tiene fecha nueva: la alerta de la agenda se apaga.
      needs_reschedule: false, reject_reason: null,
      reschedule_log: [...log, {
        from: (prev as any).scheduled_date, from_time: (prev as any).scheduled_time,
        to: nextDate, to_time: nextTime,
        at: new Date().toISOString(), by: userId ?? null, reason: body?.reason ?? null,
      }].slice(-50),
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

agendaTasks.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { error } = await db.from('agenda_tasks').delete()
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default agendaTasks;
