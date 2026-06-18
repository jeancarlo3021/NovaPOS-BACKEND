import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

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
  notes:               z.string().optional().nullable(),
  is_active:           z.boolean().optional(),
});

// GET / — list customers (?q=search)
customers.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return ok(c, []);
    const q = c.req.query('q')?.trim();
    let query = db.from('customers')
      .select('*').eq('tenant_id', tenantId).order('name').limit(500);
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
