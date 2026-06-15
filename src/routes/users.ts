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
  /** Sucursal destino (si no se pasa, se usa el tenant actual del JWT). */
  target_tenant_id: z.string().uuid().optional().nullable(),
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
    const userId   = c.get('userId');
    // Query param ?scope=group → trae users de TODAS las sucursales accesibles
    // (vía user_tenants). Default ?scope=tenant → solo del tenant actual.
    const scope = c.req.query('scope') ?? 'tenant';

    let tenantIds: string[] = tenantId ? [tenantId] : [];
    if (scope === 'group') {
      // Resolver todos los tenants donde el user tiene acceso
      const { data: ut } = await db.from('user_tenants')
        .select('tenant_id').eq('user_id', userId);
      tenantIds = (ut ?? []).map((r: any) => r.tenant_id);
      if (tenantIds.length === 0 && tenantId) tenantIds = [tenantId];
    }

    if (tenantIds.length === 0) return ok(c, []);

    const { data, error } = await db
      .from('users')
      .select('id, full_name, email, role, phone, tenant_id, created_at, last_login_at')
      .in('tenant_id', tenantIds)
      .order('full_name');

    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — create a new user
users.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    const body     = await c.req.json();
    const parsed   = CreateUserSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Resolver tenant destino: si vino target_tenant_id, validar acceso.
    let destTenantId = parsed.data.target_tenant_id ?? tenantId;
    if (parsed.data.target_tenant_id && parsed.data.target_tenant_id !== tenantId) {
      // El creador debe tener acceso al tenant destino vía user_tenants.
      const { data: ut } = await db.from('user_tenants')
        .select('user_id').eq('user_id', userId)
        .eq('tenant_id', parsed.data.target_tenant_id).maybeSingle();
      // Plus también es válido si es el owner directo del tenant
      const { data: t } = await db.from('tenants')
        .select('owner_id').eq('id', parsed.data.target_tenant_id).maybeSingle();
      const canAccess = !!ut || t?.owner_id === userId;
      if (!canAccess) {
        return fail(c, 'No tenés acceso a la sucursal destino', 403);
      }
      destTenantId = parsed.data.target_tenant_id;
    }

    // Pre-check: no permitir emails duplicados (case-insensitive). El usuario
    // se identifica por `usuario@nexoerp.local` → si ya existe un user con ese
    // email/username, devolvemos error claro antes de llamar a Supabase Auth
    // (que falla con mensaje genérico "email already registered").
    const emailLc = parsed.data.email.trim().toLowerCase();
    const { data: existingUser } = await db
      .from('users')
      .select('id, email')
      .ilike('email', emailLc)
      .maybeSingle();
    if (existingUser) {
      const isLocalUsername = emailLc.endsWith('@nexoerp.local');
      const display = isLocalUsername ? emailLc.replace('@nexoerp.local', '') : emailLc;
      return fail(c, `Ya existe un usuario con el nombre "${display}". Elegí otro.`, 409);
    }

    // Create auth user via admin API
    const { data: authData, error: authError } = await db.auth.admin.createUser({
      email: parsed.data.email,
      password: parsed.data.password,
      email_confirm: true,
    });

    if (authError) {
      // Mensaje amigable si Supabase tira "User already registered" por carrera.
      if (/already (registered|exists)/i.test(authError.message)) {
        const display = emailLc.endsWith('@nexoerp.local')
          ? emailLc.replace('@nexoerp.local', '')
          : emailLc;
        return fail(c, `Ya existe un usuario con el nombre "${display}". Elegí otro.`, 409);
      }
      throw new Error(authError.message);
    }
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
        tenant_id: destTenantId,
      })
      .select()
      .single();

    if (userError) {
      // Rollback auth user if DB insert fails
      await db.auth.admin.deleteUser(authData.user.id);
      throw new Error(userError.message);
    }

    // Vincular en user_tenants para que el nuevo usuario pueda leer su tenant
    // vía RLS (subscriptions, etc.) y el RPC my_tenants() lo devuelva. El role
    // acá es el rol operativo del staff (cajero / gerente / etc.), NO 'owner':
    // owner queda reservado para el dueño del negocio.
    const { error: utErr } = await db.from('user_tenants').upsert({
      user_id:    authData.user.id,
      tenant_id:  destTenantId,
      role:       'staff',
      is_default: true,
    }, { onConflict: 'user_id,tenant_id' });
    if (utErr) console.warn('[users.create] user_tenants link falló:', utErr.message);

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

// ── POS Quick-Switch (kiosk mode con PIN) ──────────────────────────────────
// El terminal del POS queda logueado con un user "base". Los cajeros entran
// y salen con su PIN — solo se cambia el `activeCashier` para atribución de
// facturas, NO se reemplaza la sesión del navegador. Por eso devolvemos solo
// info pública del user, no un token.
users.post('/pin-login', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return fail(c, 'Sin tenant', 400);
    const { pin } = await c.req.json();
    if (!pin || typeof pin !== 'string' || pin.length < 3) {
      return fail(c, 'PIN inválido', 400);
    }
    const { data, error } = await db.from('users')
      .select('id, full_name, role, email')
      .eq('tenant_id', tenantId)
      .eq('pos_pin', pin)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'PIN incorrecto', 401);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PATCH /:id/pin — setear o cambiar el PIN de un usuario (solo owner/admin)
users.patch('/:id/pin', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { pin } = await c.req.json();
    if (pin && (typeof pin !== 'string' || !/^\d{3,8}$/.test(pin))) {
      return fail(c, 'PIN debe ser numérico de 3 a 8 dígitos', 400);
    }
    // Validar que el PIN no esté en uso por OTRO user en el mismo tenant
    if (pin) {
      const { data: existing } = await db.from('users')
        .select('id').eq('tenant_id', tenantId).eq('pos_pin', pin).neq('id', id).maybeSingle();
      if (existing) return fail(c, 'Ese PIN ya lo usa otro usuario', 409);
    }
    const { error } = await db.from('users')
      .update({ pos_pin: pin || null })
      .eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── Role Permissions ────────────────────────────────────────────────────────

/*
  SQL: ver migrations/09_role_permissions.sql
*/

const VALID_ROLES = [
  'owner', 'admin', 'gerente', 'asistente_1', 'asistente_2', 'asistente_3',
  'cocinero', 'mesero', 'cajero', 'almacenero', 'contador',
] as const;

const RolePermissionsSchema = z.record(
  z.string(),
  z.object({
    can_access: z.boolean().optional(),
    can_create: z.boolean().optional(),
    can_edit: z.boolean().optional(),
    can_delete: z.boolean().optional(),
  })
);

// GET /roles/:role/permissions — get permission matrix for a role
users.get('/roles/:role/permissions', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { role } = c.req.param();
    if (!VALID_ROLES.includes(role as any)) return fail(c, 'Rol inválido', 422);

    const { data, error } = await db
      .from('role_permissions')
      .select('module, can_access, can_create, can_edit, can_delete')
      .eq('tenant_id', tenantId)
      .eq('role', role);

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

// PUT /roles/:role/permissions — upsert permission matrix for a role
users.put('/roles/:role/permissions', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    const { role } = c.req.param();
    console.log('[role-perms] PUT', { tenantId, userId, role });

    if (!tenantId) {
      return fail(c, 'Tenant ID requerido — verificá que el user tenga tenant asignado', 400);
    }
    if (!VALID_ROLES.includes(role as any)) return fail(c, 'Rol inválido', 422);

    const body = await c.req.json();
    console.log('[role-perms] body keys:', Object.keys(body ?? {}));

    const parsed = RolePermissionsSchema.safeParse(body);
    if (!parsed.success) {
      console.error('[role-perms] schema parse failed:', parsed.error.message);
      return fail(c, parsed.error.message, 422);
    }

    // ── Multi-empresa: si el caller es owner de un grupo, replicamos la
    //    configuración a TODAS las sucursales del grupo. Así con guardar
    //    una vez aplica a Demo + prueba 1 + prueba 2.
    //    Estrategia: buscar todos los tenants donde el caller es 'owner' en
    //    user_tenants. Si encuentra más de uno, replicar a todos.
    const { data: ownedRows } = await db.from('user_tenants')
      .select('tenant_id').eq('user_id', userId).eq('role', 'owner');
    let targetTenantIds = (ownedRows ?? []).map((r: any) => r.tenant_id);
    if (targetTenantIds.length === 0) targetTenantIds = [tenantId];
    console.log('[role-perms] applying to tenants:', targetTenantIds);

    // Borrar las matrices viejas de este rol en TODOS los tenants destino.
    const { error: delErr } = await db
      .from('role_permissions')
      .delete()
      .in('tenant_id', targetTenantIds)
      .eq('role', role);
    if (delErr) {
      console.error('[role-perms] DELETE error:', delErr.message);
      throw new Error('DELETE: ' + delErr.message);
    }

    // Generar filas: cada módulo × cada tenant destino.
    const perms = targetTenantIds.flatMap((tid: string) =>
      Object.entries(parsed.data).map(([module, p]) => ({
        tenant_id: tid,
        role,
        module,
        can_access: p.can_access ?? false,
        can_create: p.can_create ?? false,
        can_edit: p.can_edit ?? false,
        can_delete: p.can_delete ?? false,
      }))
    );
    console.log('[role-perms] insert rows:', perms.length);

    if (perms.length > 0) {
      const { error, data } = await db.from('role_permissions').insert(perms).select();
      if (error) {
        console.error('[role-perms] INSERT error:', error.message);
        throw new Error('INSERT: ' + error.message);
      }
      console.log('[role-perms] inserted', data?.length, 'rows');
    }

    return ok(c, {
      message: 'Permisos del rol actualizados',
      inserted: perms.length,
      tenants: targetTenantIds.length,
    });
  } catch (err: any) {
    console.error('[role-perms] FAIL:', err.message);
    return fail(c, err.message, 500);
  }
});

export default users;
