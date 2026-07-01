import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const cabys = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// GET /search?q=  — búsqueda global por código o descripción (todos los usuarios).
cabys.get('/search', async (c) => {
  try {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) return ok(c, []);
    let query = db.from('cabys_catalog').select('code, description, iva_rate').limit(30);
    if (/^\d+$/.test(q)) query = query.ilike('code', `${q}%`);
    else query = query.ilike('description', `%${q}%`);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /count — cuántos códigos hay cargados.
cabys.get('/count', async (c) => {
  try {
    const { count } = await db.from('cabys_catalog').select('code', { count: 'exact', head: true });
    return ok(c, { count: count ?? 0 });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /bulk — carga masiva (super-admin, desde el Excel). body: { rows: [{code, description, iva_rate, sheet}] }
cabys.post('/bulk', async (c) => {
  try {
    const b = await c.req.json();
    const rows: any[] = Array.isArray(b.rows) ? b.rows : [];
    const clean = rows
      .filter(r => r?.code && r?.description)
      .map(r => ({
        code: String(r.code).trim(),
        description: String(r.description).trim().slice(0, 500),
        iva_rate: Number.isFinite(Number(r.iva_rate)) ? Number(r.iva_rate) : 13,
        sheet: r.sheet ?? 'catalogo',
        updated_at: new Date().toISOString(),
      }));
    if (clean.length === 0) return ok(c, { inserted: 0 });
    const { error } = await db.from('cabys_catalog').upsert(clean, { onConflict: 'code' });
    if (error) throw new Error(error.message);
    return ok(c, { inserted: clean.length });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// DELETE / — vaciar el catálogo (para recargar).
cabys.delete('/', async (c) => {
  try {
    const { error } = await db.from('cabys_catalog').delete().neq('code', '');
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default cabys;
