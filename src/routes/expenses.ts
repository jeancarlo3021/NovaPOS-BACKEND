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

/**
 * LAS SALIDAS DE CAJA TAMBIÉN SON GASTOS.
 *
 * Cuando en la caja se saca plata para pagar el pescado, las bolsas o un Uber,
 * eso queda en `cash_movements` y nunca llegaba al módulo de Gastos: el negocio
 * veía un total de gastos que no incluía la plata que de verdad salió del
 * cajón. Medido en la base: 572 salidas por ₡4.169.590 en cuatro meses, de seis
 * negocios, ninguna visible en Gastos.
 *
 * Se MUESTRAN, no se copian. Crear un gasto de verdad por cada salida dejaría
 * dos registros del mismo dinero —uno editable y otro no— y bastaría con que
 * alguien anotara el gasto a mano para contarlo dos veces. Acá se leen de donde
 * ya están y se marcan con `origen: 'caja'`.
 *
 * Qué entra: SOLO las salidas que el cajero registró a mano, que son las que el
 * modal de caja escribe con el prefijo «Salida: ». Quedan fuera a propósito:
 *  - el cierre de caja (es el efectivo que se retira al cuadrar, no un gasto),
 *  - las anulaciones y devoluciones (es plata que se le devuelve al cliente:
 *    menos venta, no más gasto).
 */
const PREFIJO_SALIDA = 'Salida:';

/** La categoría que se les pone. No existe en la base: es una etiqueta. */
const CATEGORIA_CAJA = {
  id: 'caja',
  name: 'Salidas de caja',
  color: '#0ea5e9',
  icon: '💵',
};

/**
 * El día en que ocurrió, en hora de Costa Rica.
 *
 * `created_at` viene en UTC: una salida de las 6 p.m. del lunes es «martes» si
 * se corta el texto sin convertir, y cae fuera del día que el dueño está
 * mirando.
 */
function diaCR(ts: any): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts ?? '').slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Costa_Rica', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/**
 * Trae TODAS las filas, no las primeras mil.
 *
 * PostgREST devuelve como máximo 1.000 por consulta y no avisa de las que
 * dejó fuera. Hoy el negocio con más gastos tiene 384, así que nadie lo había
 * notado; el día que uno pase de mil, el total del reporte empezaría a dar de
 * menos sin ningún error a la vista. Peor que un número equivocado es un
 * número equivocado que parece bueno.
 */
const PAGINA = 1000;
async function todasLasFilas(construir: (desde: number, hasta: number) => any): Promise<any[]> {
  const acumulado: any[] = [];
  for (let i = 0; i < 50; i++) {        // tope de seguridad: 50.000 filas
    const { data, error } = await construir(i * PAGINA, i * PAGINA + PAGINA - 1);
    if (error) throw new Error(error.message);
    const lote = data ?? [];
    acumulado.push(...lote);
    if (lote.length < PAGINA) break;
  }
  return acumulado;
}

async function salidasDeCaja(tenantId: string, from?: string, to?: string, buscar?: string) {
  // Las sesiones del tenant: `cash_movements` no guarda tenant_id.
  // Paginadas: un negocio con años de cajas pasa de mil sesiones, y con la
  // lista cortada sus salidas más viejas desaparecían del reporte.
  const sesiones = await todasLasFilas((d, h) => db.from('cash_sessions')
    .select('id').eq('tenant_id', tenantId).order('id').range(d, h));
  const ids = sesiones.map((s: any) => s.id);
  if (!ids.length) return [];

  let data: any[];
  try {
    data = await todasLasFilas((d, h) => {
      let q = db.from('cash_movements')
        .select('id, cash_session_id, amount, description, created_at')
        .in('cash_session_id', ids)
        .eq('type', 'expense')
        .ilike('description', `${PREFIJO_SALIDA}%`)
        .order('created_at', { ascending: false }).range(d, h);
      // El rango viene por día; `created_at` es un instante, así que el «hasta»
      // tiene que cubrir todo el día o se pierden las salidas de la tarde.
      if (from) q = q.gte('created_at', `${from}T00:00:00`);
      if (to)   q = q.lte('created_at', `${to}T23:59:59.999`);
      // El buscador de la pantalla de Gastos también tiene que encontrarlas:
      // si la lista filtra los gastos y deja todas las salidas, el resultado
      // es una búsqueda que devuelve más de lo que se buscó.
      if (buscar) q = q.ilike('description', `%${buscar}%`);
      return q;
    });
  } catch (e: any) { console.warn('[expenses] salidas de caja:', e?.message); return []; }

  return data.map((m: any) => ({
    // Prefijo en el id: si alguna pantalla intenta editarla o borrarla, falla
    // con un «no encontrado» en vez de tocar un gasto ajeno por casualidad.
    id: `caja:${m.id}`,
    tenant_id: tenantId,
    category_id: null,
    category: CATEGORIA_CAJA,
    amount: Math.abs(Number(m.amount) || 0),   // en caja se guardan en negativo
    description: String(m.description ?? '').replace(/^Salida:\s*/i, '') || 'Salida de caja',
    date: diaCR(m.created_at),
    payment_method: 'cash',
    type: 'variable',
    reference: null,
    notes: null,
    created_at: m.created_at,
    updated_at: m.created_at,
    /** La marca: la interfaz la usa para no ofrecer editar ni borrar. */
    origen: 'caja' as const,
    cash_movement_id: m.id,
  }));
}

// GET / — lista de gastos.
//   ?from= ?to= ?category= ?type= ?search= ?caja=0 (excluir las salidas de caja)
expenses.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const category = c.req.query('category');
    const type = c.req.query('type');
    const search = (c.req.query('search') ?? '').trim();

    const data = await todasLasFilas((desde, hasta) => {
      /*
       * La CATEGORÍA viaja con el gasto.
       *
       * Antes era `select('*')` y la categoría nunca llegaba: la pantalla
       * mostraba la columna vacía y el reporte metía TODO en una porción
       * llamada «Sin categoría» —384 de 384 gastos medidos—, con el gráfico
       * y el porcentaje diciendo que el negocio gasta el 100% en nada.
       */
      let query = db
        .from('expenses')
        .select('*, category:expense_categories(id, name, color, icon)')
        .eq('tenant_id', tenantId)
        .order('date', { ascending: false })
        .range(desde, hasta);

      if (from) query = query.gte('date', from);
      if (to) query = query.lte('date', to);
      /*
       * La columna es `category_id`. Con `category` PostgREST responde «column
       * expenses.category does not exist» y el módulo devolvía 500: el filtro
       * por categoría de la pantalla de Gastos nunca funcionó.
       */
      if (category && category !== CATEGORIA_CAJA.id) query = query.eq('category_id', category);
      // El tipo (fijo / variable / ocasional) y el buscador: la pantalla los
      // mandaba desde siempre y acá se ignoraban, así que el selector y la
      // caja de búsqueda no hacían absolutamente nada.
      if (type) query = query.eq('type', type);
      if (search) {
        const t = search.replace(/[%,()]/g, ' ');
        query = query.or(`description.ilike.%${t}%,reference.ilike.%${t}%,notes.ilike.%${t}%`);
      }
      return query;
    });

    /**
     * Las salidas de caja se suman salvo que se pidan aparte.
     *
     * Con un filtro de categoría puesto NO entran: no tienen categoría propia
     * —el cajero escribe un motivo, no elige de la lista—, y colarlas en una
     * categoría que el dueño eligió sería mentirle sobre qué está mirando. La
     * excepción es cuando el filtro ES la etiqueta de caja.
     *
     * Con un filtro de TIPO distinto de «variable» tampoco: una salida de caja
     * no es un gasto fijo ni ocasional, es plata que salió del cajón ese día.
     */
    const quiereCaja = c.req.query('caja') !== '0';
    const filtroDeOtraCategoria = !!category && category !== CATEGORIA_CAJA.id;
    const filtroDeOtroTipo = !!type && type !== 'variable';
    if (!quiereCaja || filtroDeOtraCategoria || filtroDeOtroTipo) return ok(c, data);

    const caja = await salidasDeCaja(tenantId, from, to, search || undefined);
    const todo = category === CATEGORIA_CAJA.id ? caja : [...data, ...caja];
    todo.sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)));
    return ok(c, todo);
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
