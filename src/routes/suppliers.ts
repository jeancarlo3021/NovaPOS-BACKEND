import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const suppliers = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/**
 * EL PROVEEDOR, con TODAS las casillas que la pantalla sabe llenar.
 *
 * Acá faltaban `city`, `country` y `payment_terms`. Zod BORRA en silencio lo
 * que no está en el esquema, así que la edición «funcionaba» —200, sin error—
 * y esas tres casillas volvían como estaban: el plazo de pago que se acababa
 * de poner se perdía y nadie podía explicar por qué. Peor en un PUT que solo
 * cambiaba el plazo: el parche quedaba VACÍO y la actualización no tocaba
 * nada. Lo mismo le pasaba al proveedor creado desde la orden de compra, que
 * manda el plazo.
 *
 * Si se agrega una columna al proveedor, va acá también. Una casilla que la
 * pantalla manda y el servidor no conoce no da error: se pierde.
 */
const SupplierSchema = z.object({
  name: z.string().min(1),
  contact_name: z.string().optional().nullable(),
  /* El correo vacío llega como '' desde el formulario; eso no es un correo
     inválido, es «no tiene correo». Sin esto, guardar un proveedor sin correo
     devolvía un 422 con el error crudo de Zod en pantalla. */
  email: z.preprocess(
    v => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().email('El correo no es válido').optional().nullable(),
  ),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  payment_terms: z.string().optional().nullable(),
  tax_id: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  is_active: z.boolean().optional(),
});

/**
 * El error de Postgres cuando una columna no existe, en castellano y diciendo
 * CUÁL. Si mañana se agrega una casilla al formulario y a este esquema pero no
 * a la tabla, el mensaje tiene que decir qué falta, no «PGRST204».
 */
const mensajeDeError = (msg: string): string => {
  const m = /column "?([a-z_]+)"? .*does not exist|Could not find the '([a-z_]+)' column/i.exec(msg);
  const col = m?.[1] ?? m?.[2];
  return col
    ? `La base de datos no tiene la columna «${col}» en proveedores. Hay que agregarla antes de poder guardar ese dato.`
    : msg;
};

// GET / — list suppliers (supports ?search=)
suppliers.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const search = c.req.query('search');

    let query = db
      .from('suppliers')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('name');

    if (search) {
      query = query.or(`name.ilike.%${search}%,contact_name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

/**
 * GET /:id — UN proveedor.
 *
 * Faltaba. La pantalla de editar lo pide por id para llenar el formulario, así
 * que al tocar el lápiz la respuesta era un 404 y salía «Error al cargar el
 * proveedor»: la modificación no fallaba al guardar, fallaba antes de empezar,
 * y por eso no había forma de corregir un proveedor desde la pantalla.
 */
suppliers.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data, error } = await db.from('suppliers')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    /* De otro negocio o inexistente es lo mismo desde afuera: 404. Distinguirlo
       le diría a un tenant qué ids existen en otro. */
    if (!data) return fail(c, 'Proveedor no encontrado', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — create supplier
suppliers.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const parsed = SupplierSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('suppliers')
      .insert({ ...parsed.data, tenant_id: tenantId })
      .select()
      .single();

    if (error) throw new Error(mensajeDeError(error.message));
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /:id — update supplier
suppliers.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = SupplierSchema.partial().safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    /* Un parche vacío NO es un éxito. Antes caía en un update sin campos, que
       Postgres rechaza con un error ilegible; y si algún día no lo rechazara,
       sería peor: un 200 que no guardó nada. */
    const patch = parsed.data as Record<string, unknown>;
    if (Object.keys(patch).length === 0) {
      return fail(c, 'No llegó ningún dato que cambiar.', 422);
    }

    const { data, error } = await db
      .from('suppliers')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    /* Sin filas no es un error del servidor: es un proveedor que no existe o
       que es de otro negocio. `.single()` lo reporta como error, así que hay
       que distinguirlo antes de tirar un 500. */
    if (error) {
      if ((error as any).code === 'PGRST116') return fail(c, 'Proveedor no encontrado', 404);
      throw new Error(mensajeDeError(error.message));
    }
    if (!data) return fail(c, 'Proveedor no encontrado', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /:id — delete supplier
suppliers.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { error } = await db
      .from('suppliers')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default suppliers;
