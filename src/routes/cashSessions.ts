import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const cashSessions = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const OpenSessionSchema = z.object({
  opening_balance: z.number().nonnegative(),
  notes: z.string().optional().nullable(),
});

const CloseSessionSchema = z.object({
  closing_balance: z.number().nonnegative(),
  total_cash: z.number().nonnegative().optional(),
  total_card: z.number().nonnegative().optional(),
  total_other: z.number().nonnegative().optional(),
  notes: z.string().optional().nullable(),
});

// GET / — list cash sessions (?from=, ?to=)
cashSessions.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to = c.req.query('to');

    let query = db
      .from('cash_sessions')
      .select('*, users(id, full_name, email)')
      .eq('tenant_id', tenantId)
      .order('opened_at', { ascending: false });

    if (from) query = query.gte('opened_at', from);
    if (to) query = query.lte('opened_at', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /active — get open session (closed_at is null)
cashSessions.get('/active', async (c) => {
  try {
    const tenantId = c.get('tenantId');

    const { data, error } = await db
      .from('cash_sessions')
      .select('*, users(id, full_name, email)')
      .eq('tenant_id', tenantId)
      .is('closed_at', null)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /open — open a new cash session
cashSessions.post('/open', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json();
    const parsed = OpenSessionSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Check if there's already an open session
    const { data: existing } = await db
      .from('cash_sessions')
      .select('id')
      .eq('tenant_id', tenantId)
      .is('closed_at', null)
      .maybeSingle();

    if (existing) return fail(c, 'Ya hay una caja abierta', 400);

    const { data, error } = await db
      .from('cash_sessions')
      .insert({
        ...parsed.data,
        tenant_id: tenantId,
        opened_by: userId,
        opened_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /:id/close — close a session
cashSessions.post('/:id/close', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = CloseSessionSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data: session } = await db
      .from('cash_sessions')
      .select('id, closed_at')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!session) return fail(c, 'Sesión no encontrada', 404);
    if (session.closed_at) return fail(c, 'La sesión ya está cerrada', 400);

    const { data, error } = await db
      .from('cash_sessions')
      .update({
        ...parsed.data,
        closed_at: new Date().toISOString(),
        closed_by: userId,
      })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default cashSessions;
