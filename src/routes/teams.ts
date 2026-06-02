import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/*
  SQL Migration (run once in Supabase SQL editor):

  CREATE TABLE IF NOT EXISTS teams (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    color       TEXT NOT NULL DEFAULT '#3b82f6',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(team_id, user_id)
  );

  CREATE INDEX idx_teams_tenant ON teams(tenant_id);
  CREATE INDEX idx_team_members_team ON team_members(team_id);
  CREATE INDEX idx_team_members_user ON team_members(user_id);
*/

const teams = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const CreateTeamSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  color: z.string().optional().default('#3b82f6'),
});

const UpdateTeamSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  color: z.string().optional(),
});

const AddMemberSchema = z.object({
  user_id: z.string().uuid(),
});

// GET / — list teams for tenant (con miembros inline para UI)
teams.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');

    const { data, error } = await db
      .from('teams')
      .select(`
        id, name, description, color, created_at,
        members:team_members(
          id, user_id, added_at,
          users(id, full_name, email, role)
        )
      `)
      .eq('tenant_id', tenantId)
      .order('name');

    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /:id — get team details with members
teams.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data: team, error: teamError } = await db
      .from('teams')
      .select('id, name, description, color, created_at')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (teamError) throw new Error(teamError.message);
    if (!team) return fail(c, 'Equipo no encontrado', 404);

    const { data: members, error: membersError } = await db
      .from('team_members')
      .select('id, user_id, added_at, users(id, full_name, email, role)')
      .eq('team_id', id);

    if (membersError) console.error('Error fetching members:', membersError);

    return ok(c, {
      ...team,
      members: members || [],
    });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — create team
teams.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const parsed = CreateTeamSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('teams')
      .insert({
        tenant_id: tenantId,
        name: parsed.data.name,
        description: parsed.data.description,
        color: parsed.data.color,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /:id — update team
teams.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = UpdateTeamSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Verify team belongs to tenant
    const { data: team } = await db
      .from('teams')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (!team) return fail(c, 'Equipo no encontrado', 404);

    const updateData: Record<string, any> = {};
    if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
    if (parsed.data.description !== undefined) updateData.description = parsed.data.description;
    if (parsed.data.color !== undefined) updateData.color = parsed.data.color;

    const { data, error } = await db
      .from('teams')
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

// DELETE /:id — delete team
teams.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    // Verify team belongs to tenant
    const { data: team } = await db
      .from('teams')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (!team) return fail(c, 'Equipo no encontrado', 404);

    // Delete team (cascade deletes members)
    const { error } = await db.from('teams').delete().eq('id', id);
    if (error) throw new Error(error.message);

    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /:id/members — add member to team
teams.post('/:id/members', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = AddMemberSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Verify team belongs to tenant
    const { data: team } = await db
      .from('teams')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (!team) return fail(c, 'Equipo no encontrado', 404);

    // Verify user belongs to tenant
    const { data: user } = await db
      .from('users')
      .select('id')
      .eq('id', parsed.data.user_id)
      .eq('tenant_id', tenantId)
      .single();

    if (!user) return fail(c, 'Usuario no encontrado', 404);

    const { data, error } = await db
      .from('team_members')
      .insert({
        team_id: id,
        user_id: parsed.data.user_id,
      })
      .select()
      .single();

    if (error) {
      if (error.message.includes('duplicate')) {
        return fail(c, 'El usuario ya es miembro del equipo', 409);
      }
      throw new Error(error.message);
    }

    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /:id/members/:userId — remove member from team
teams.delete('/:id/members/:userId', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id, userId } = c.req.param();

    // Verify team belongs to tenant
    const { data: team } = await db
      .from('teams')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (!team) return fail(c, 'Equipo no encontrado', 404);

    const { error } = await db
      .from('team_members')
      .delete()
      .eq('team_id', id)
      .eq('user_id', userId);

    if (error) throw new Error(error.message);

    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default teams;
