import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/*
  SQL Migration (run once in Supabase SQL editor):

  CREATE TABLE IF NOT EXISTS shifts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL,
    user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    team_id        UUID REFERENCES teams(id) ON DELETE SET NULL,
    start_datetime TIMESTAMPTZ NOT NULL,
    end_datetime   TIMESTAMPTZ,
    status         TEXT NOT NULL DEFAULT 'scheduled', -- 'scheduled', 'active', 'completed', 'cancelled'
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX idx_shifts_tenant ON shifts(tenant_id);
  CREATE INDEX idx_shifts_user ON shifts(user_id);
  CREATE INDEX idx_shifts_team ON shifts(team_id);
  CREATE INDEX idx_shifts_status ON shifts(status);
  CREATE INDEX idx_shifts_datetime ON shifts(start_datetime, end_datetime);
*/

const shifts = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const CreateShiftSchema = z.object({
  user_id: z.string().uuid().optional(),
  team_id: z.string().uuid().optional(),
  start_datetime: z.string().datetime(),
  end_datetime: z.string().datetime().optional(),
  status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).optional().default('scheduled'),
  notes: z.string().optional(),
});

const UpdateShiftSchema = z.object({
  user_id: z.string().uuid().optional(),
  team_id: z.string().uuid().optional(),
  start_datetime: z.string().datetime().optional(),
  end_datetime: z.string().datetime().optional(),
  status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).optional(),
  notes: z.string().optional(),
});

// GET / — list shifts (with filters: user_id, team_id, from, to, status)
shifts.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.req.query('user_id');
    const teamId = c.req.query('team_id');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const status = c.req.query('status');
    const limit = parseInt(c.req.query('limit') || '500', 10);

    let query = db
      .from('shifts')
      .select('id, user_id, team_id, start_datetime, end_datetime, status, notes, created_at, users(id, full_name), teams(id, name)')
      .eq('tenant_id', tenantId)
      .order('start_datetime', { ascending: false })
      .limit(limit);

    if (userId) query = query.eq('user_id', userId);
    if (teamId) query = query.eq('team_id', teamId);
    if (status) query = query.eq('status', status);
    if (from) query = query.gte('start_datetime', from);
    if (to) query = query.lte('start_datetime', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /:id — get shift details
shifts.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data, error } = await db
      .from('shifts')
      .select('id, user_id, team_id, start_datetime, end_datetime, status, notes, created_at, users(id, full_name), teams(id, name)')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Turno no encontrado', 404);

    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — create shift
shifts.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const parsed = CreateShiftSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Validate user_id if provided
    if (parsed.data.user_id) {
      const { data: user } = await db
        .from('users')
        .select('id')
        .eq('id', parsed.data.user_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!user) return fail(c, 'Usuario no encontrado', 404);
    }

    // Validate team_id if provided
    if (parsed.data.team_id) {
      const { data: team } = await db
        .from('teams')
        .select('id')
        .eq('id', parsed.data.team_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!team) return fail(c, 'Equipo no encontrado', 404);
    }

    const { data, error } = await db
      .from('shifts')
      .insert({
        tenant_id: tenantId,
        user_id: parsed.data.user_id || null,
        team_id: parsed.data.team_id || null,
        start_datetime: parsed.data.start_datetime,
        end_datetime: parsed.data.end_datetime || null,
        status: parsed.data.status,
        notes: parsed.data.notes,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /:id — update shift
shifts.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = UpdateShiftSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Verify shift belongs to tenant
    const { data: shift } = await db
      .from('shifts')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!shift) return fail(c, 'Turno no encontrado', 404);

    const updateData: Record<string, any> = {};
    if (parsed.data.user_id !== undefined) updateData.user_id = parsed.data.user_id;
    if (parsed.data.team_id !== undefined) updateData.team_id = parsed.data.team_id;
    if (parsed.data.start_datetime !== undefined) updateData.start_datetime = parsed.data.start_datetime;
    if (parsed.data.end_datetime !== undefined) updateData.end_datetime = parsed.data.end_datetime;
    if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
    if (parsed.data.notes !== undefined) updateData.notes = parsed.data.notes;

    const { data, error } = await db
      .from('shifts')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /:id — delete shift
shifts.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    // Verify shift belongs to tenant
    const { data: shift } = await db
      .from('shifts')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!shift) return fail(c, 'Turno no encontrado', 404);

    const { error } = await db.from('shifts').delete().eq('id', id);
    if (error) throw new Error(error.message);

    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default shifts;
