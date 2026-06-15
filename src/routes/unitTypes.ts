import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const unitTypes = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const UnitTypeSchema = z.object({
  name: z.string().min(1),
  abbreviation: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  requires_weight: z.boolean().optional(),
});

// GET / — list unit types
unitTypes.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db
      .from('unit_types')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('name');

    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — create unit type
unitTypes.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const parsed = UnitTypeSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('unit_types')
      .insert({ ...parsed.data, tenant_id: tenantId })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /:id — update unit type
unitTypes.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = UnitTypeSchema.partial().safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('unit_types')
      .update(parsed.data)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Tipo de unidad no encontrado', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /:id — delete unit type
unitTypes.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { error } = await db
      .from('unit_types')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default unitTypes;
