import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { getUserZone } from '../utils/userZone.js';

const customers = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const CustomerSchema = z.object({
  identification_type: z.string().optional().nullable(),
  identification:      z.string().optional().nullable(),
  name:                z.string().min(1),
  commercial_name:     z.string().optional().nullable(),
  email:               z.string().email().optional().nullable().or(z.literal('')),
  phone:               z.string().optional().nullable(),
  province_code:       z.string().optional().nullable(),
  canton_code:         z.string().optional().nullable(),
  district_code:       z.string().optional().nullable(),
  address:             z.string().optional().nullable(),
  economic_activity_code: z.string().optional().nullable(),
  zone:                z.string().optional().nullable(),
  notes:               z.string().optional().nullable(),
  is_active:           z.boolean().optional(),
  credit_enabled:      z.boolean().optional(),
  credit_limit:        z.number().nonnegative().optional(),
});

// ── Zonas (lista administrable) ──────────────────────────────────────────────
customers.get('/zones', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('customer_zones')
      .select('*').eq('tenant_id', tenantId).order('name');
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

customers.post('/zones', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { name } = await c.req.json() as { name?: string };
    if (!name?.trim()) return fail(c, 'Nombre requerido', 422);
    const { data, error } = await db.from('customer_zones')
      .insert({ tenant_id: tenantId, name: name.trim() }).select().single();
    if (error) {
      if ((error as any).code === '23505') return fail(c, 'La zona ya existe', 409);
      throw new Error(error.message);
    }
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

customers.delete('/zones/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db.from('customer_zones').delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET / — list customers (?q=search)
customers.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return ok(c, []);
    const q = c.req.query('q')?.trim();
    let query = db.from('customers')
      .select('*').eq('tenant_id', tenantId).order('name').limit(500);
    // Restricción por zona: si el usuario tiene zona asignada, solo ve esa zona.
    const userZone = await getUserZone(c.get('userId'));
    if (userZone) query = query.eq('zone', userZone);
    if (q) {
      // ilike sobre name + identification + email
      query = query.or(`name.ilike.%${q}%,identification.ilike.%${q}%,email.ilike.%${q}%,commercial_name.ilike.%${q}%`);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id
customers.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data, error } = await db.from('customers')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Cliente no encontrado', 404);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /
customers.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return fail(c, 'Tenant requerido', 400);
    const body = await c.req.json();
    const parsed = CustomerSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const row = { ...parsed.data, tenant_id: tenantId, email: parsed.data.email || null };
    const { data, error } = await db.from('customers').insert(row).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /:id
customers.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = CustomerSchema.partial().safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const { data, error } = await db.from('customers')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// DELETE /:id (soft delete)
customers.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const hard = c.req.query('hard') === 'true';
    if (hard) {
      // Eliminación real (borra el registro y sus precios especiales por cascade).
      const { error } = await db.from('customers')
        .delete().eq('id', id).eq('tenant_id', tenantId);
      if (error) throw new Error(error.message);
      return ok(c, { deleted: true, hard: true });
    }
    // Por defecto: desactivar (soft delete).
    const { error } = await db.from('customers')
      .update({ is_active: false }).eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default customers;
