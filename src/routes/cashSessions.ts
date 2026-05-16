import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const cashSessions = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// Schema matches actual DB: opening_amount, status='open'/'closed'
const OpenSchema  = z.object({ opening_amount: z.number().nonnegative(), notes: z.string().optional().nullable() });
const CloseSchema = z.object({
  closing_amount:  z.number().nonnegative().optional(),
  closing_balance: z.number().nonnegative().optional(), // alias for backward compat
  notes: z.string().optional().nullable(),
}).transform(d => ({
  ...d,
  closing_amount: d.closing_amount ?? d.closing_balance ?? 0,
}));

cashSessions.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = c.req.query('to');

    let query = db.from('cash_sessions').select('*').eq('tenant_id', tenantId)
      .order('opening_date', { ascending: false });
    if (from) query = query.gte('opening_date', from);
    if (to)   query = query.lte('opening_date', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

cashSessions.get('/active', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('cash_sessions').select('*')
      .eq('tenant_id', tenantId).eq('status', 'open').maybeSingle();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

cashSessions.post('/open', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    const parsed   = OpenSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Only one open session at a time
    const { data: existing } = await db.from('cash_sessions').select('id')
      .eq('tenant_id', tenantId).eq('status', 'open').maybeSingle();
    if (existing) return fail(c, 'Ya hay una caja abierta', 409);

    const { data, error } = await db.from('cash_sessions').insert({
      tenant_id:      tenantId,
      user_id:        userId,
      opening_amount: parsed.data.opening_amount,
      opening_date:   new Date().toISOString(),
      status:         'open',
      notes:          parsed.data.notes,
    }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

cashSessions.post('/:id/close', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const parsed   = CloseSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db.from('cash_sessions').update({
      closing_amount: parsed.data.closing_amount,
      closing_date:   new Date().toISOString(),
      status:         'closed',
      notes:          parsed.data.notes,
      updated_at:     new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/movements — register cash movement
cashSessions.post('/:id/movements', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const { data, error } = await db.from('cash_movements').insert({
      cash_session_id: id,
      type:            body.type,
      amount:          body.amount,
      description:     body.description ?? '',
      reference_id:    body.reference_id ?? null,
    }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default cashSessions;
