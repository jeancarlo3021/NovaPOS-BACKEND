import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const users = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  full_name: z.string().min(1),
  role: z.enum([
    'owner', 'admin', 'gerente', 'asistente_1', 'asistente_2', 'asistente_3',
    'cocinero', 'mesero', 'cajero', 'almacenero', 'contador',
  ]).optional().default('asistente_1'),
  phone: z.string().optional().nullable(),
});

const UpdateUserSchema = z.object({
  full_name: z.string().min(1).optional(),
  role: z.enum([
    'owner', 'admin', 'gerente', 'asistente_1', 'asistente_2', 'asistente_3',
    'cocinero', 'mesero', 'cajero', 'almacenero', 'contador',
  ]).optional(),
  phone: z.string().optional().nullable(),
});

const ResetPasswordSchema = z.object({
  password: z.string().min(6),
});

// GET / — list users for the tenant
users.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');

    const { data, error } = await db
      .from('users')
      .select('id, full_name, email, role, phone, created_at')
      .eq('tenant_id', tenantId)
      .order('full_name');

    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — create a new user
users.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const parsed = CreateUserSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Create auth user via admin API
    const { data: authData, error: authError } = await db.auth.admin.createUser({
      email: parsed.data.email,
      password: parsed.data.password,
      email_confirm: true,
    });

    if (authError) throw new Error(authError.message);
    if (!authData.user) throw new Error('No se pudo crear el usuario');

    // Insert into users table
    const { data: userData, error: userError } = await db
      .from('users')
      .insert({
        id: authData.user.id,
        email: parsed.data.email,
        full_name: parsed.data.full_name,
        role: parsed.data.role,
        phone: parsed.data.phone,
        tenant_id: tenantId,
      })
      .select()
      .single();

    if (userError) {
      // Rollback auth user if DB insert fails
      await db.auth.admin.deleteUser(authData.user.id);
      throw new Error(userError.message);
    }

    return ok(c, userData, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /:id — delete user
users.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const selfId = c.get('userId');

    if (id === selfId) return fail(c, 'No puedes eliminarte a ti mismo', 400);

    // Verify user belongs to tenant
    const { data: user } = await db
      .from('users')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!user) return fail(c, 'Usuario no encontrado', 404);

    // Delete from auth
    const { error: authError } = await db.auth.admin.deleteUser(id);
    if (authError) throw new Error(authError.message);

    // Delete from users table (may be handled by cascade)
    await db.from('users').delete().eq('id', id).eq('tenant_id', tenantId);

    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /roles — list available roles
users.get('/roles', async (c) => {
  const roles = [
    { value: 'owner', label: 'Propietario' },
    { value: 'admin', label: 'Administrador' },
    { value: 'gerente', label: 'Gerente' },
    { value: 'asistente_1', label: 'Asistente 1' },
    { value: 'asistente_2', label: 'Asistente 2' },
    { value: 'asistente_3', label: 'Asistente 3' },
    { value: 'cocinero', label: 'Cocinero' },
    { value: 'mesero', label: 'Mesero' },
    { value: 'cajero', label: 'Cajero' },
    { value: 'almacenero', label: 'Almacenero' },
    { value: 'contador', label: 'Contador' },
  ];
  return ok(c, roles);
});

// PUT /:id — update user (full_name, role, phone)
users.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = UpdateUserSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Verify user belongs to tenant
    const { data: user } = await db
      .from('users')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!user) return fail(c, 'Usuario no encontrado', 404);

    const updateData: Record<string, any> = {};
    if (parsed.data.full_name !== undefined) updateData.full_name = parsed.data.full_name;
    if (parsed.data.role !== undefined) updateData.role = parsed.data.role;
    if (parsed.data.phone !== undefined) updateData.phone = parsed.data.phone;

    const { data: updated, error } = await db
      .from('users')
      .update(updateData)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, updated);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PATCH /:id/password — reset user password (admin resets another user's password)
users.patch('/:id/password', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = ResetPasswordSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Verify user belongs to tenant
    const { data: user } = await db
      .from('users')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!user) return fail(c, 'Usuario no encontrado', 404);

    // Reset password via admin API
    const { error } = await db.auth.admin.updateUserById(id, {
      password: parsed.data.password,
    });

    if (error) throw new Error(error.message);
    return ok(c, { message: 'Contraseña actualizada' });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// ── Permissions ───────────────────────────────────────────────────────────────

/*
  SQL (run once in Supabase):
  CREATE TABLE IF NOT EXISTS user_permissions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module      TEXT NOT NULL,
    can_access  BOOLEAN NOT NULL DEFAULT false,
    can_create  BOOLEAN NOT NULL DEFAULT false,
    can_edit    BOOLEAN NOT NULL DEFAULT false,
    can_delete  BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, module)
  );
*/

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

// GET /:id/permissions — get all permissions for a user
users.get('/:id/permissions', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data, error } = await db
      .from('user_permissions')
      .select('module, can_access, can_create, can_edit, can_delete')
      .eq('tenant_id', tenantId)
      .eq('user_id', id);

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

// PUT /:id/permissions — upsert all permissions for a user
users.put('/:id/permissions', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = UserPermissionsSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Verify user belongs to tenant
    const { data: user } = await db
      .from('users')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!user) return fail(c, 'Usuario no encontrado', 404);

    // Delete existing permissions for this user
    await db
      .from('user_permissions')
      .delete()
      .eq('user_id', id)
      .eq('tenant_id', tenantId);

    // Insert new permissions
    const perms = Object.entries(parsed.data).map(([module, perms]) => ({
      tenant_id: tenantId,
      user_id: id,
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

export default users;
