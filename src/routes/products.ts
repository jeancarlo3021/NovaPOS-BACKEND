import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const products = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const ProductSchema = z.object({
  name:            z.string().min(1),
  sku:             z.string().optional().default(''),
  sku2:            z.string().optional().nullable(),   // segundo código (alterno/barras)
  description:     z.string().optional().nullable(),
  unit_price:      z.number().nonnegative().optional().nullable(),
  delivery_price:  z.number().nonnegative().optional().nullable(),   // precio para delivery
  cost_price:      z.number().nonnegative().optional().nullable(),
  stock_quantity:  z.number().int().nonnegative().optional().default(0),
  min_stock_level: z.number().int().nonnegative().optional().default(0),
  max_stock_level: z.number().int().nonnegative().optional().default(100),
  category_id:     z.string().uuid().optional().nullable(),
  unit_type_id:    z.string().uuid().optional().nullable(),
  supplier_id:     z.string().uuid().optional().nullable(),
  is_favorite:     z.boolean().optional(),
  image_url:       z.string().url().optional().nullable(),
  tracks_stock:    z.boolean().optional(),
  cabys_code:      z.string().optional().nullable(),
  iva_rate:        z.number().nonnegative().max(100).optional().nullable(),
  exclude_from_fe: z.boolean().optional(),   // no enviar a Hacienda (productos sin precio)
});

products.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const search   = c.req.query('search');
    const category = c.req.query('category');

    // Paginamos para traer TODOS los productos: Supabase corta en 1000 filas por
    // defecto, así que un catálogo grande (importado por Excel) no aparecía completo.
    const PAGE = 1000;
    // Trae todo paginado; `filterDeleted` oculta los soft-deleted (deleted_at).
    const fetchAll = async (filterDeleted: boolean): Promise<{ data?: any[]; error?: any }> => {
      const all: any[] = [];
      for (let from = 0; ; from += PAGE) {
        let query = db.from('products').select('*').eq('tenant_id', tenantId).order('name')
          .range(from, from + PAGE - 1);
        if (filterDeleted) query = query.is('deleted_at', null);
        if (search)   query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%,sku2.ilike.%${search}%`);
        if (category) query = query.eq('category_id', category);
        const { data, error } = await query;
        if (error) return { error };
        const chunk = data ?? [];
        all.push(...chunk);
        if (chunk.length < PAGE) break;   // última página
      }
      return { data: all };
    };
    // Si la columna deleted_at no existe aún (migración 58 sin correr), reintenta sin filtro.
    let res = await fetchAll(true);
    if (res.error && /deleted_at/.test(res.error.message ?? '')) res = await fetchAll(false);
    if (res.error) throw new Error(res.error.message);

    return ok(c, res.data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

products.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data, error } = await db.from('products').select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Producto no encontrado', 404);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

products.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = ProductSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db.from('products')
      .insert({
        ...parsed.data,
        // Default solo al CREAR: si no se especifica, rastrea stock.
        tracks_stock: parsed.data.tracks_stock ?? true,
        tenant_id: tenantId,
      })
      .select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

products.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const parsed = ProductSchema.partial().safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db.from('products')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId)
      .select().single();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Producto no encontrado', 404);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

products.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    // Intento de borrado real.
    const { error } = await db.from('products').delete().eq('id', id).eq('tenant_id', tenantId);
    if (!error) return ok(c, { deleted: true });

    // Si el producto tiene compras/ventas asociadas (FK), NO se puede borrar sin
    // perder el historial → SOFT-DELETE: se OCULTA marcando deleted_at.
    const fk = /foreign key|violates|purchase_items|invoice_items|_fkey|23503/i.test(error.message ?? '');
    if (fk) {
      // Se LIBERA el código (sku) al ocultar, para que se pueda volver a usar en un
      // producto nuevo sin chocar con el constraint único. El original queda con un
      // sufijo para conservar la referencia en el historial.
      const { data: prod } = await db.from('products').select('sku, sku2').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
      const suffix = `#x${Date.now().toString(36)}`;
      const freedSku = prod?.sku ? String(prod.sku).slice(0, 40) + suffix : `del${suffix}`;
      const soft = await db.from('products')
        .update({ deleted_at: new Date().toISOString(), sku: freedSku, sku2: null })
        .eq('id', id).eq('tenant_id', tenantId);
      if (soft.error) {
        // La columna deleted_at no existe (migración 58 sin correr).
        if (/deleted_at/.test(soft.error.message)) {
          return fail(c, 'El producto tiene compras o ventas asociadas y no se puede eliminar. (Corré la migración 58 para poder ocultarlo.)', 409);
        }
        throw new Error(soft.error.message);
      }
      return ok(c, { deleted: true, soft: true });
    }
    throw new Error(error.message);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default products;
