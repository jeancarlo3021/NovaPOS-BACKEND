import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const expenses = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// Categorías por defecto (con EMOJI real — la UI las muestra como `{icon} {name}`).
const DEFAULT_CATEGORIES: Array<{ id: string; name: string; color: string; icon: string }> = [
  { id: '1',  name: 'Servicios públicos',    color: '#3b82f6', icon: '⚡' },
  { id: '2',  name: 'Suministros',           color: '#10b981', icon: '📦' },
  { id: '3',  name: 'Salarios',              color: '#f59e0b', icon: '👥' },
  { id: '4',  name: 'Alquiler',              color: '#ef4444', icon: '🏠' },
  { id: '5',  name: 'Mercadería',            color: '#8b5cf6', icon: '🛒' },
  { id: '6',  name: 'Combustible',           color: '#f97316', icon: '⛽' },
  { id: '7',  name: 'Mantenimiento',         color: '#64748b', icon: '🔧' },
  { id: '8',  name: 'Transporte',            color: '#06b6d4', icon: '🚚' },
  { id: '9',  name: 'Impuestos',             color: '#e11d48', icon: '🏛️' },
  { id: '10', name: 'Publicidad',            color: '#a855f7', icon: '📣' },
  { id: '11', name: 'Comisiones bancarias',  color: '#6366f1', icon: '🏦' },
  { id: '12', name: 'Otros',                 color: '#6b7280', icon: '💰' },
];

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

    // Gastos registrados OFFLINE: el front manda el created_at del momento real
    // de creación. Sin esto, al sincronizar tarde quedaría con la hora del sync y
    // podría caer fuera de la ventana del cierre del repartidor.
    const row: Record<string, any> = { ...parsed.data, tenant_id: tenantId, user_id: c.get('userId') ?? null };
    const clientCreatedAt = body?.created_at;
    if (typeof clientCreatedAt === 'string' && !isNaN(Date.parse(clientCreatedAt))) {
      row.created_at = clientCreatedAt;
    }

    const { data, error } = await db
      .from('expenses')
      .insert(row)
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
  return ok(c, DEFAULT_CATEGORIES);
});

// GET /categories — tenant expense categories. Si el tenant no tiene ninguna,
// se auto-crean las por defecto (así el selector nunca queda vacío).
expenses.get('/categories', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db
      .from('expense_categories')
      .select('*')
      .eq('tenant_id', tenantId);
    if (error) return ok(c, []);

    if ((data ?? []).length === 0) {
      const rows = DEFAULT_CATEGORIES.map(cat => ({
        tenant_id: tenantId, name: cat.name, color: cat.color, icon: cat.icon,
        general_category_id: cat.id, is_general: true,
      }));
      let seededRes = await db.from('expense_categories').insert(rows).select();
      // Si la columna general_category_id sigue siendo UUID (migración 59 sin
      // correr), reintenta sin ese campo para no romper el sembrado.
      if (seededRes.error && /uuid|general_category_id/i.test(seededRes.error.message)) {
        const rows2 = rows.map(({ general_category_id, ...r }) => r);
        seededRes = await db.from('expense_categories').insert(rows2).select();
      }
      return ok(c, seededRes.data ?? []);
    }
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

    const general = DEFAULT_CATEGORIES.find(x => x.id === general_category_id);
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

    let ins = await db
      .from('expense_categories')
      .insert({
        tenant_id: tenantId, general_category_id, is_general: true,
        name: general.name, color: general.color, icon: general.icon,
      })
      .select()
      .single();
    // Si general_category_id es UUID (migración 59 pendiente), reintenta sin él.
    if (ins.error && /uuid|general_category_id/i.test(ins.error.message)) {
      ins = await db.from('expense_categories')
        .insert({ tenant_id: tenantId, is_general: true, name: general.name, color: general.color, icon: general.icon })
        .select().single();
    }
    if (ins.error) throw new Error(ins.error.message);
    return ok(c, ins.data, 201);
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
