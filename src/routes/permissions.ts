import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/*
  SQL Migration (run once in Supabase SQL editor):

  CREATE TABLE IF NOT EXISTS user_permissions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module      TEXT NOT NULL,  -- 'pos', 'inventory', 'reports', 'expenses', 'purchases', 'users', 'promotions', 'accounts_payable', 'hr'
    can_access  BOOLEAN NOT NULL DEFAULT false,
    can_create  BOOLEAN NOT NULL DEFAULT false,
    can_edit    BOOLEAN NOT NULL DEFAULT false,
    can_delete  BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, module)
  );

  CREATE INDEX idx_user_permissions_tenant_user ON user_permissions(tenant_id, user_id);
  CREATE INDEX idx_user_permissions_user_module ON user_permissions(user_id, module);
*/

const permissions = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const PermissionSchema = z.object({
  module: z.string().min(1),
  can_access: z.boolean().optional().default(false),
  can_create: z.boolean().optional().default(false),
  can_edit: z.boolean().optional().default(false),
  can_delete: z.boolean().optional().default(false),
});

const UserPermissionsSchema = z.record(
  z.string(),
  z.object({
    can_access: z.boolean().optional(),
    can_create: z.boolean().optional(),
    can_edit: z.boolean().optional(),
    can_delete: z.boolean().optional(),
  })
);

// GET /users/:userId/permissions — get all permissions for a user
permissions.get('/users/:userId/permissions', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { userId } = c.req.param();

    const { data, error } = await db
      .from('user_permissions')
      .select('module, can_access, can_create, can_edit, can_delete')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId);

    if (error) throw new Error(error.message);

    const result: Record<string, any> = {};
    (data || []).forEach(perm => {
      result[perm.module] = {
        can_access: perm.can_access,
        can_create: perm.can_create,
        can_edit: perm.can_edit,
        can_delete: perm.can_delete,
      };
    });

    return ok(c, result);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /users/:userId/permissions — upsert all permissions for a user (matrix)
permissions.put('/users/:userId/permissions', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { userId } = c.req.param();
    const body = await c.req.json();
    const parsed = UserPermissionsSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Verify user belongs to tenant
    const { data: user } = await db
      .from('users')
      .select('id')
      .eq('id', userId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!user) return fail(c, 'Usuario no encontrado', 404);

    // Delete existing permissions for this user
    await db
      .from('user_permissions')
      .delete()
      .eq('user_id', userId)
      .eq('tenant_id', tenantId);

    // Insert new permissions
    const perms = Object.entries(parsed.data).map(([module, perms]) => ({
      tenant_id: tenantId,
      user_id: userId,
      module,
      can_access: perms.can_access ?? false,
      can_create: perms.can_create ?? false,
      can_edit: perms.can_edit ?? false,
      can_delete: perms.can_delete ?? false,
    }));

    if (perms.length > 0) {
      const { error } = await db.from('user_permissions').insert(perms);
      if (error) throw new Error(error.message);
    }

    return ok(c, { message: 'Permisos actualizados' });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default permissions;
