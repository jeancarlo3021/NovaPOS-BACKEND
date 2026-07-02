import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const expenses = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const ExpenseSchema = z.object({
  description: z.string().min(1),
  amount: z.number().positive(),
  category: z.string().optional().nullable(),
  category_id: z.string().uuid().optional().nullable(),   // categoría (FK) — requerida por la BD
  date: z.string().optional(),
  payment_method: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

// GET / — list expenses (?from=, ?to=, ?category=)
expenses.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const category = c.req.query('category');

    let query = db
      .from('expenses')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('date', { ascending: false });

    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);
    if (category) query = query.eq('category', category);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — create expense
expenses.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const parsed = ExpenseSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('expenses')
      .insert({ ...parsed.data, tenant_id: tenantId, user_id: c.get('userId') ?? null })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /:id — update expense
expenses.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = ExpenseSchema.partial().safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('expenses')
      .update(parsed.data)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Gasto no encontrado', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /:id — delete expense
expenses.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { error } = await db
      .from('expenses')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /categories/general — general expense categories
expenses.get('/categories/general', async (c) => {
  return ok(c, [
    { id: '1', name: 'Servicios', color: '#3b82f6', icon: 'Zap' },
    { id: '2', name: 'Suministros', color: '#10b981', icon: 'Package' },
    { id: '3', name: 'Salarios', color: '#f59e0b', icon: 'Users' },
    { id: '4', name: 'Renta', color: '#ef4444', icon: 'Home' },
  ]);
});

// GET /categories — tenant expense categories
expenses.get('/categories', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db
      .from('expense_categories')
      .select('*')
      .eq('tenant_id', tenantId);

    if (error) return ok(c, []);
    return ok(c, data ?? []);
  } catch {
    return ok(c, []);
  }
});

// POST /categories/from-general — adopt general category (idempotente)
expenses.post('/categories/from-general', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { general_category_id } = await c.req.json() as { general_category_id: string };

    const generalCategories: Record<string, any> = {
      '1': { name: 'Servicios', color: '#3b82f6', icon: 'Zap' },
      '2': { name: 'Suministros', color: '#10b981', icon: 'Package' },
      '3': { name: 'Salarios', color: '#f59e0b', icon: 'Users' },
      '4': { name: 'Renta', color: '#ef4444', icon: 'Home' },
    };

    const general = generalCategories[general_category_id];
    if (!general) return fail(c, 'Categoría no encontrada', 404);

    // Si el tenant ya tiene una categoría con ese nombre, devolverla en vez de
    // intentar insertar y romper el unique constraint (tenant_id, name).
    const { data: existing } = await db
      .from('expense_categories')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('name', general.name)
      .maybeSingle();

    if (existing) {
      // Si la fila existente no tiene el vínculo a la categoría general, lo
      // completamos para que el picker la marque como adoptada en próximos cargas.
      if (!existing.general_category_id) {
        const { data: updated } = await db
          .from('expense_categories')
          .update({ general_category_id, is_general: true })
          .eq('id', existing.id)
          .select()
          .single();
        return ok(c, updated ?? existing, 200);
      }
      return ok(c, existing, 200);
    }

    const { data, error } = await db
      .from('expense_categories')
      .insert({ tenant_id: tenantId, general_category_id, is_general: true, ...general })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /categories — create custom category
expenses.post('/categories', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { name, color, icon } = await c.req.json() as { name: string; color: string; icon: string };

    const trimmed = (name ?? '').trim();
    if (!trimmed) return fail(c, 'El nombre es requerido', 422);

    // Detectar duplicado antes del insert para devolver 409 con mensaje claro
    const { data: existing } = await db
      .from('expense_categories')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .ilike('name', trimmed)
      .maybeSingle();

    if (existing) {
      return fail(c, `Ya existe una categoría llamada "${existing.name}"`, 409);
    }

    const { data, error } = await db
      .from('expense_categories')
      .insert({ tenant_id: tenantId, name: trimmed, color, icon })
      .select()
      .single();

    if (error) {
      if ((error.message || '').includes('expense_categories_tenant_id_name_key')) {
        return fail(c, `Ya existe una categoría con ese nombre`, 409);
      }
      throw new Error(error.message);
    }
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /categories/:id — update category
expenses.put('/categories/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json() as Partial<{ name: string; color: string; icon: string }>;

    const { data, error } = await db
      .from('expense_categories')
      .update(body)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Categoría no encontrada', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /categories/:id — delete category
expenses.delete('/categories/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { error } = await db
      .from('expense_categories')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /recurring — list recurring expenses
expenses.get('/recurring', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db
      .from('recurring_expenses')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('next_date', { ascending: true });

    if (error) return ok(c, []);
    return ok(c, data ?? []);
  } catch {
    return ok(c, []);
  }
});

// POST /recurring — create recurring expense
expenses.post('/recurring', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();

    const { data, error } = await db
      .from('recurring_expenses')
      .insert({ tenant_id: tenantId, ...body })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /recurring/:id — update recurring expense
expenses.put('/recurring/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();

    const { data, error } = await db
      .from('recurring_expenses')
      .update(body)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Gasto recurrente no encontrado', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /recurring/:id — delete recurring expense
expenses.delete('/recurring/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { error } = await db
      .from('recurring_expenses')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PATCH /recurring/:id/toggle — toggle recurring expense
expenses.patch('/recurring/:id/toggle', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data: current, error: fetchErr } = await db
      .from('recurring_expenses')
      .select('is_active')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (fetchErr || !current) return fail(c, 'Gasto recurrente no encontrado', 404);

    const { data, error } = await db
      .from('recurring_expenses')
      .update({ is_active: !current.is_active })
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default expenses;
