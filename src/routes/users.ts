import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { forgetCachedUser } from '../middleware/auth.js';
import { ok, fail } from '../utils/response.js';
import { clearPermissionCache } from '../middleware/permissions.js';

const users = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// Contraseña segura: al menos 6 caracteres y combinar letras y números.
const securePassword = z.string().min(6)
  .regex(/[a-zA-Z]/, 'La contraseña debe combinar letras y números')
  .regex(/[0-9]/, 'La contraseña debe combinar letras y números');

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: securePassword,
  full_name: z.string().min(1),
  role: z.enum([
    'owner', 'admin', 'gerente', 'asistente_1', 'asistente_2', 'asistente_3',
    'cocinero', 'mesero', 'cajero', 'almacenero', 'contador', 'repartidor',
    // 'agente': arma pedidos y los envía a caja (no cobra). Sin esto, un agente
    // creado desde su módulo no se podía editar desde Usuarios.
    'agente',
  ]).optional().default('asistente_1'),
  phone: z.string().optional().nullable(),
  /** Zona asignada: si se setea, el usuario solo ve clientes/CxC de esa zona. */
  zone: z.string().optional().nullable(),
  /** Sucursal destino (si no se pasa, se usa el tenant actual del JWT). */
  target_tenant_id: z.string().uuid().optional().nullable(),
});

const UpdateUserSchema = z.object({
  full_name: z.string().min(1).optional(),
  role: z.enum([
    'owner', 'admin', 'gerente', 'asistente_1', 'asistente_2', 'asistente_3',
    'cocinero', 'mesero', 'cajero', 'almacenero', 'contador', 'repartidor',
    // 'agente': arma pedidos y los envía a caja (no cobra). Sin esto, un agente
    // creado desde su módulo no se podía editar desde Usuarios.
    'agente',
  ]).optional(),
  phone: z.string().optional().nullable(),
  zone: z.string().optional().nullable(),
  ticket_alias: z.string().max(60).optional().nullable(),
});

const ResetPasswordSchema = z.object({
  password: securePassword,
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
      .select('id, full_name, email, role, phone, zone, ticket_alias, tenant_id, created_at, last_login_at')
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

    // Límite de usuarios según el plan del tenant destino. max_users null = ilimitado.
    {
      const { data: sub } = await db.from('subscriptions')
        .select('subscription_plans(max_users, name)')
        .eq('tenant_id', destTenantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const plan: any = (sub as any)?.subscription_plans ?? null;
      const maxUsers: number | null = plan?.max_users ?? null;
      if (maxUsers != null) {
        const { count } = await db.from('users')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', destTenantId);
        const current = count ?? 0;
        if (current >= maxUsers) {
          return fail(c, `Tu plan${plan?.name ? ` "${plan.name}"` : ''} permite hasta ${maxUsers} usuario${maxUsers === 1 ? '' : 's'}. Ya tenés ${current}. Mejorá tu plan para agregar más.`, 403);
        }
      }
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
        zone: parsed.data.zone ?? null,
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
    { value: 'repartidor', label: 'Repartidor' },
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
    if (parsed.data.zone !== undefined) updateData.zone = parsed.data.zone;
    if (parsed.data.ticket_alias !== undefined) updateData.ticket_alias = parsed.data.ticket_alias || null;

    const { data: updated, error } = await db
      .from('users')
      .update(updateData)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    // Cambiarle el rol a alguien tiene que aplicarse en la siguiente pantalla,
    // no cuando venza la memoria corta del middleware de autenticación.
    forgetCachedUser(id);
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

/**
 * PUT /:id/email — cambia el correo (y con él, el USUARIO con el que entra).
 *
 * ── Por qué hace falta ─────────────────────────────────────────────────────
 * El correo no es un dato de contacto: es la identidad con la que se inicia
 * sesión. Se equivocaron al crearlo, la persona cambió de correo, o el negocio
 * quiere pasar de un usuario interno («caja1») a su correo real — y hasta ahora
 * la única salida era borrar el usuario y crearlo de nuevo, perdiendo su
 * historial: qué vendió, qué anuló, qué cajas cerró.
 *
 * Se cambia en LOS DOS lados: en el sistema de acceso (que es quien valida el
 * ingreso) y en la ficha del usuario. Si el primero falla, no se toca el
 * segundo: dejar la ficha diciendo un correo con el que no se puede entrar es
 * peor que no cambiar nada.
 */
users.put('/:id/email', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    if (!['owner', 'admin', 'gerente'].includes(String(c.get('role')))) {
      return fail(c, 'Solo el dueño, el administrador o el gerente pueden cambiar el correo', 403);
    }

    const body = await c.req.json().catch(() => ({} as any));
    const bruto = String(body?.email ?? '').trim().toLowerCase();
    if (!bruto) return fail(c, 'Escribí el correo o el nombre de usuario', 422);

    // Sin arroba se asume nombre de usuario, igual que al crearlo: «caja1» pasa
    // a ser caja1@nexoerp.local, que es con lo que el sistema de acceso trabaja.
    const email = bruto.includes('@') ? bruto : `${bruto}@nexoerp.local`;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail(c, 'Ese correo no es válido', 422);
    }

    const { data: user } = await db.from('users')
      .select('id, email').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!user) return fail(c, 'Usuario no encontrado', 404);
    if (String((user as any).email ?? '').toLowerCase() === email) {
      return ok(c, { message: 'Ese ya es su correo', email });
    }

    // Ocupado por otra persona: cambiarlo dejaría a dos usuarios con la misma
    // identidad y ninguno podría entrar con seguridad.
    const { data: ocupado } = await db.from('users')
      .select('id').eq('email', email).neq('id', id).maybeSingle();
    if (ocupado) return fail(c, 'Ya hay otro usuario con ese correo', 409);

    // 1) El sistema de acceso primero: es el que decide si se puede entrar.
    const { error: authErr } = await db.auth.admin.updateUserById(id, {
      email, email_confirm: true,
    });
    if (authErr) {
      return fail(c, /already|registrado|exists/i.test(authErr.message)
        ? 'Ese correo ya está registrado en el sistema'
        : authErr.message, 409);
    }

    // 2) Recién ahora la ficha.
    const { data, error } = await db.from('users')
      .update({ email, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select('id, email, full_name, role').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      return fail(c,
        'El correo de ingreso se cambió, pero no se pudo actualizar la ficha del usuario. '
        + 'Avisá para revisarlo: la persona ya entra con el correo nuevo.', 409);
    }

    // El middleware recuerda al usuario unos segundos: se olvida para que el
    // cambio aplique de inmediato.
    forgetCachedUser(id);
    return ok(c, { ...(data as any), message: 'Correo actualizado. La próxima vez entra con el nuevo.' });
  } catch (err: any) { return fail(c, err.message, 500); }
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

/**
 * Tiendas o sucursales que un usuario puede ver.
 *
 * El acceso ya existía —es `user_tenants`, lo que llena el selector de empresa—
 * pero solo se podía dar al crear el usuario (en UNA sucursal) o desde el panel
 * de grupos. Un cajero que cubre turnos en dos tiendas, o un gerente que tiene
 * que ver todas, obligaba a crear un usuario por tienda.
 *
 * Solo se tocan las tiendas que MANEJA quien edita: las que tiene como dueño (o
 * todas las suyas, si es super-admin). Lo que el usuario tenga en otras tiendas
 * no se ve ni se modifica desde acá.
 */
async function tiendasQueManeja(editorId: string): Promise<Array<{ id: string; name: string }>> {
  const { data: ut } = await db.from('user_tenants')
    .select('tenant_id, role, tenant:tenants!user_tenants_tenant_id_fkey(id, name, owner_id)')
    .eq('user_id', editorId);
  let superAdmin = false;
  try {
    const { data: u } = await db.from('users').select('tenant_id').eq('id', editorId).maybeSingle();
    const { data: t } = await db.from('tenants').select('plan_id').eq('id', (u as any)?.tenant_id ?? '').maybeSingle();
    const { data: p } = await db.from('subscription_plans').select('features').eq('id', (t as any)?.plan_id ?? '').maybeSingle();
    superAdmin = (p as any)?.features?.admin_dashboard === true;
  } catch { /* sin plan: no es super-admin */ }

  const tiendas = new Map<string, string>();
  for (const r of (ut ?? []) as any[]) {
    const esDueño = r.role === 'owner' || r.tenant?.owner_id === editorId;
    if (superAdmin || esDueño) tiendas.set(String(r.tenant_id), String(r.tenant?.name ?? 'Negocio'));
  }
  // Negocios de los que es dueño aunque le falte la fila de acceso.
  const { data: propios } = await db.from('tenants').select('id, name').eq('owner_id', editorId);
  for (const t of (propios ?? []) as any[]) tiendas.set(String(t.id), String(t.name ?? 'Negocio'));
  return [...tiendas].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

// GET /managed-tenants — tiendas que maneja quien edita (para elegir al crear un usuario)
users.get('/managed-tenants', async (c) => {
  try { return ok(c, await tiendasQueManeja(c.get('userId'))); }
  catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id/tenants — tiendas que maneja quien edita, marcando a cuáles entra el usuario
users.get('/:id/tenants', async (c) => {
  try {
    const { id } = c.req.param();
    const tiendas = await tiendasQueManeja(c.get('userId'));
    const ids = tiendas.map(t => t.id);

    const { data: usuario } = await db.from('users').select('id, tenant_id').eq('id', id).maybeSingle();
    if (!usuario) return fail(c, 'Usuario no encontrado', 404);
    const { data: accesos } = await db.from('user_tenants').select('tenant_id').eq('user_id', id);
    const conAcceso = new Set(((accesos ?? []) as any[]).map(a => String(a.tenant_id)));
    // Solo se puede administrar a alguien que está en alguna de las tiendas propias.
    const esDeMisTiendas = ids.includes(String((usuario as any).tenant_id)) || ids.some(t => conAcceso.has(t));
    if (!esDeMisTiendas) return fail(c, 'Usuario no encontrado', 404);

    return ok(c, {
      tiendas: tiendas.map(t => ({
        tenant_id: t.id, name: t.name,
        acceso: conAcceso.has(t.id) || String((usuario as any).tenant_id) === t.id,
        /** Donde está trabajando ahora: no se le puede quitar sin moverlo. */
        actual: String((usuario as any).tenant_id) === t.id,
      })),
      /** Accesos en tiendas que quien edita no maneja (no se tocan). */
      otras: [...conAcceso].filter(t => !ids.includes(t)).length,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /:id/tenants — { tenant_ids: [...] } tiendas (de las que maneja) a las que entra
users.put('/:id/tenants', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({} as any));
    const pedidas = new Set<string>((Array.isArray(body?.tenant_ids) ? body.tenant_ids : []).map(String));

    const tiendas = await tiendasQueManeja(c.get('userId'));
    const ids = new Set(tiendas.map(t => t.id));
    for (const t of pedidas) if (!ids.has(t)) return fail(c, 'No administrás una de las tiendas elegidas.', 403);

    const { data: usuario } = await db.from('users').select('id, tenant_id, role').eq('id', id).maybeSingle();
    if (!usuario) return fail(c, 'Usuario no encontrado', 404);
    const { data: filas } = await db.from('user_tenants').select('tenant_id, role, is_default').eq('user_id', id);
    const actuales = ((filas ?? []) as any[]);
    const conAcceso = new Set(actuales.map(a => String(a.tenant_id)));
    const actual = String((usuario as any).tenant_id ?? '');
    if (!ids.has(actual) && ![...ids].some(t => conAcceso.has(t))) return fail(c, 'Usuario no encontrado', 404);

    // Lo que tiene fuera de mis tiendas se conserva tal cual.
    const quedan = new Set([...conAcceso].filter(t => !ids.has(t)));
    for (const t of pedidas) quedan.add(t);
    if (quedan.size === 0) return fail(c, 'El usuario tiene que poder entrar al menos a una tienda.', 422);

    const agregar = [...pedidas].filter(t => !conAcceso.has(t));
    const quitar = [...conAcceso].filter(t => ids.has(t) && !pedidas.has(t));

    if (agregar.length) {
      // El dueño sigue siendo dueño en las otras tiendas; el resto entra como personal.
      const rol = (usuario as any).role === 'owner' ? 'owner' : 'staff';
      const { error } = await db.from('user_tenants').upsert(
        agregar.map(t => ({ user_id: id, tenant_id: t, role: rol, is_default: false })),
        { onConflict: 'user_id,tenant_id' });
      if (error) throw new Error(error.message);
    }
    if (quitar.length) {
      const { error } = await db.from('user_tenants').delete().eq('user_id', id).in('tenant_id', quitar);
      if (error) throw new Error(error.message);
    }

    /**
     * Si le quitaron la tienda en la que está trabajando, se lo pasa a otra.
     * El negocio activo de un usuario es `users.tenant_id`: sin moverlo, seguiría
     * adentro de la tienda que ya no puede ver hasta que cambiara a mano.
     */
    let movidoA: string | null = null;
    if (!quedan.has(actual)) {
      const preferida = actuales.find(a => a.is_default && quedan.has(String(a.tenant_id)))?.tenant_id;
      movidoA = String(preferida ?? [...pedidas][0] ?? [...quedan][0]);
      const { error } = await db.from('users').update({ tenant_id: movidoA }).eq('id', id);
      if (error) throw new Error(error.message);
      await db.from('user_tenants').update({ is_default: true }).eq('user_id', id).eq('tenant_id', movidoA);
    }
    forgetCachedUser(id);

    return ok(c, { agregadas: agregar.length, quitadas: quitar.length, movido_a: movidoA });
  } catch (err: any) { return fail(c, err.message, 500); }
});

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
      .select('id, full_name, role, email, ticket_alias')
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
  'cocinero', 'mesero', 'cajero', 'almacenero', 'contador', 'repartidor',
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

    // El middleware cachea la matriz un minuto: sin esto, quitarle un permiso a
    // alguien seguiría dejándolo pasar hasta que venza el cache.
    clearPermissionCache();

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
