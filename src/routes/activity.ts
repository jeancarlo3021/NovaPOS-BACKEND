import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/*
  SQL Migration (run once in Supabase SQL editor):

  CREATE TABLE IF NOT EXISTS user_activity_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    user_name   TEXT,        -- snapshot del nombre al momento
    action      TEXT NOT NULL, -- 'login', 'invoice_created', 'purchase_created', 'user_created', 'user_deleted', etc.
    entity_type TEXT,          -- 'invoice', 'purchase', 'user', 'expense', 'team', 'shift'
    entity_id   TEXT,
    details     JSONB,
    ip_address  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX idx_activity_tenant ON user_activity_log(tenant_id);
  CREATE INDEX idx_activity_user ON user_activity_log(user_id);
  CREATE INDEX idx_activity_created ON user_activity_log(created_at);
*/

const activity = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const LogActivitySchema = z.object({
  action: z.string().min(1),
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
  details: z.record(z.any()).optional(),
  user_name: z.string().optional(),
});

// GET / — get activity logs for tenant (with filters)
//   ?scope=tenant (default) — sólo el tenant actual
//   ?scope=group  — todas las sucursales del grupo (donde el caller es owner)
//   ?tenant_id=X  — sólo esa sucursal específica (debe ser accesible)
activity.get('/', async (c) => {
  try {
    const callerUserId = c.get('userId');
    const callerTenant = c.get('tenantId');
    const scope = c.req.query('scope') ?? 'tenant';
    const tenantIdFilter = c.req.query('tenant_id');
    const userId = c.req.query('user_id');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const action = c.req.query('action');
    const limit = parseInt(c.req.query('limit') || '100', 10);

    // Resolver tenants a consultar
    let tenantIds: string[] = callerTenant ? [callerTenant] : [];
    if (scope === 'group') {
      const { data: rows } = await db.from('user_tenants')
        .select('tenant_id').eq('user_id', callerUserId);
      tenantIds = (rows ?? []).map((r: any) => r.tenant_id);
      if (tenantIds.length === 0 && callerTenant) tenantIds = [callerTenant];
    }
    if (tenantIdFilter) {
      // Validar que el caller tenga acceso a ese tenant
      if (!tenantIds.includes(tenantIdFilter)) {
        const { data: ut } = await db.from('user_tenants')
          .select('tenant_id').eq('user_id', callerUserId).eq('tenant_id', tenantIdFilter).maybeSingle();
        if (!ut) return fail(c, 'Sin acceso a esa sucursal', 403);
      }
      tenantIds = [tenantIdFilter];
    }

    if (tenantIds.length === 0) return ok(c, []);

    let query = db
      .from('user_activity_log')
      .select('id, tenant_id, user_id, user_name, action, entity_type, entity_id, details, created_at')
      .in('tenant_id', tenantIds)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (userId) query = query.eq('user_id', userId);
    if (action) query = query.eq('action', action);
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /user/:userId — get activity logs for a specific user
activity.get('/user/:userId', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { userId } = c.req.param();
    const from = c.req.query('from');
    const to = c.req.query('to');
    const limit = parseInt(c.req.query('limit') || '100', 10);

    let query = db
      .from('user_activity_log')
      .select('id, user_id, user_name, action, entity_type, entity_id, details, created_at')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — log an activity (called by other modules)
activity.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json();
    const parsed = LogActivitySchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('user_activity_log')
      .insert({
        tenant_id: tenantId,
        user_id: userId,
        user_name: parsed.data.user_name,
        action: parsed.data.action,
        entity_type: parsed.data.entity_type,
        entity_id: parsed.data.entity_id,
        details: parsed.data.details,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default activity;
