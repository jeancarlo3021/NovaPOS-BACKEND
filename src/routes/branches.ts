import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const branches = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const CreateBranchSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).max(20),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  hacienda_branch_code: z.string().optional().nullable(),
});

const UpdateBranchSchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().min(1).max(20).optional(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  hacienda_branch_code: z.string().optional().nullable(),
  is_active: z.boolean().optional(),
});

// GET / — todas las sucursales del tenant
branches.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db
      .from('branches')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('is_default', { ascending: false })
      .order('code');
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /mine — sucursales asignadas al usuario actual
branches.get('/mine', async (c) => {
  try {
    const userId   = c.get('userId');
    const tenantId = c.get('tenantId');

    // Si no hay user_branches para el user, devuelve todas las del tenant
    // (los admins/owners suelen no estar asignados pero deben verlas todas).
    const { data: assigned, error } = await db
      .from('user_branches')
      .select('branch_id, is_default, branches(*)')
      .eq('user_id', userId);
    if (error) throw new Error(error.message);

    if (!assigned || assigned.length === 0) {
      const { data: all } = await db.from('branches')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .order('is_default', { ascending: false });
      return ok(c, (all ?? []).map(b => ({ ...b, is_user_default: b.is_default })));
    }

    return ok(c, assigned.map((row: any) => ({
      ...row.branches,
      is_user_default: row.is_default,
    })));
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — crear sucursal
branches.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = CreateBranchSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('branches')
      .insert({ tenant_id: tenantId, ...parsed.data })
      .select()
      .single();

    if (error) {
      if (error.message.includes('branches_tenant_id_code_key') || error.message.includes('duplicate')) {
        return fail(c, `Ya existe una sucursal con el código "${parsed.data.code}"`, 409);
      }
      throw new Error(error.message);
    }

    // Crear automáticamente una bodega Principal para esta sucursal.
    await db.from('warehouses').insert({
      tenant_id: tenantId,
      branch_id: data.id,
      name: 'Bodega Principal',
      code: 'BOD01',
      is_default: true,
    });

    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /:id — actualizar
branches.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const parsed = UpdateBranchSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('branches')
      .update(parsed.data)
      .eq('id', id).eq('tenant_id', tenantId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Sucursal no encontrada', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /:id/set-default — marcar como la sucursal default del tenant
branches.post('/:id/set-default', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    await db.from('branches').update({ is_default: false }).eq('tenant_id', tenantId);
    const { error } = await db.from('branches').update({ is_default: true }).eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /:id — desactivar (no borrar para conservar histórico)
branches.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    // No permitir desactivar la default.
    const { data: b } = await db.from('branches').select('is_default').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (b?.is_default) return fail(c, 'No puedes desactivar la sucursal principal. Marca otra como principal primero.', 409);
    const { error } = await db.from('branches').update({ is_active: false }).eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// ── User-Branches ─────────────────────────────────────────────────────────

// PUT /:id/users — reemplazar lista de usuarios asignados a esta sucursal
branches.put('/:id/users', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json() as { user_ids: string[] };

    // Verifica que la sucursal exista en el tenant.
    const { data: br } = await db.from('branches').select('id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!br) return fail(c, 'Sucursal no encontrada', 404);

    await db.from('user_branches').delete().eq('branch_id', id);
    if (Array.isArray(body.user_ids) && body.user_ids.length > 0) {
      const rows = body.user_ids.map(uid => ({ user_id: uid, branch_id: id }));
      const { error } = await db.from('user_branches').insert(rows);
      if (error) throw new Error(error.message);
    }
    return ok(c, { ok: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default branches;
