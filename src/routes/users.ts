import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const users = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  full_name: z.string().min(1),
  role: z.enum(['owner', 'manager', 'staff']).optional().default('staff'),
  phone: z.string().optional().nullable(),
});

// GET / — list users for the tenant
users.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');

    const { data, error } = await db
      .from('users')
      .select('id, full_name, email, role, phone, is_active, created_at')
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
        is_active: true,
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

export default users;
