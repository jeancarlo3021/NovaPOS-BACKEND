import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const cabys = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// Quita acentos y pasa a minúsculas para comparar/rankear.
const norm = (s: string) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// GET /search?q=  — búsqueda global por código o descripción (todos los usuarios).
// Soporta multi-palabra: cada palabra debe aparecer (en cualquier orden) en la
// descripción. Los resultados se ordenan por relevancia.
cabys.get('/search', async (c) => {
  try {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) return ok(c, []);

    let query = db.from('cabys_catalog').select('code, description, iva_rate').limit(60);
    if (/^\d+$/.test(q)) {
      // Búsqueda por código: por prefijo.
      query = query.ilike('code', `${q}%`);
    } else {
      // Búsqueda por texto: cada palabra (≥2 letras) debe estar en la descripción.
      const words = norm(q).split(/\s+/).filter(w => w.length >= 2);
      for (const w of (words.length ? words : [norm(q)])) {
        // unaccent no está garantizado en la columna; usamos ilike sobre el texto original.
        query = query.ilike('description', `%${w}%`);
      }
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    // Ranking: coincidencia exacta > empieza con > palabra al inicio > contiene.
    const nq = norm(q);
    const words = nq.split(/\s+/).filter(Boolean);
    const score = (r: any) => {
      const d = norm(r.description);
      if (d === nq) return 0;
      if (d.startsWith(nq)) return 1;
      if (words.every(w => new RegExp(`\\b${w}`).test(d))) return 2;  // cada palabra al inicio de alguna palabra
      return 3;
    };
    const ranked = (data ?? []).slice().sort((a, b) => {
      const sa = score(a), sb = score(b);
      if (sa !== sb) return sa - sb;
      return norm(a.description).length - norm(b.description).length;  // más corto = más específico
    });
    return ok(c, ranked.slice(0, 30));
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
