import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * ENVÍOS DEL EQUIPO — lo que cada empleado deja anotado.
 *
 * Dos listas que en la práctica son la misma libreta:
 *  · ENVÍOS: a quién hay que mandarle algo, por dónde y si ya salió.
 *  · CONTACTOS: a quién hay que escribirle o llamar, por qué, y qué contestó.
 *
 * Lo que las hace útiles no es la lista —esa ya existe en cualquier cuaderno—
 * sino QUIÉN la anotó y QUIÉN la atendió. Sin esos dos nombres, cuando un
 * cliente reclama que nunca le llegó, no hay a quién preguntarle.
 */

export const envios = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const hoyCR = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Costa_Rica' }).format(new Date());

/** El nombre de quien está usando el sistema, para firmar el apunte. */
async function quienEs(c: any): Promise<{ id: string; nombre: string }> {
  const id = String(c.get('userId') ?? '');
  try {
    const { data } = await db.from('users').select('full_name, email').eq('id', id).maybeSingle();
    const u: any = data;
    return { id, nombre: u?.full_name || u?.email || 'Sin nombre' };
  } catch { return { id, nombre: 'Sin nombre' }; }
}

// ═══════════════════════════ ENVÍOS ═══════════════════════════

const EnvioSchema = z.object({
  cliente: z.string().min(1).max(200),
  customer_id: z.string().uuid().optional().nullable(),
  telefono: z.string().max(40).optional().nullable(),
  direccion: z.string().max(400).optional().nullable(),
  detalle: z.string().max(500).optional().nullable(),
  medio: z.enum(['correos', 'uber', 'mensajero', 'retiro', 'otro']).default('correos'),
  fecha: z.string().optional(),
  impresion_id: z.string().uuid().optional().nullable(),
  notas: z.string().max(500).optional().nullable(),
});

/**
 * GET /?fecha=&estado=
 *
 * Por omisión trae lo PENDIENTE de cualquier día, no solo lo de hoy: un envío
 * que se quedó sin mandar el viernes sigue siendo trabajo el lunes, y filtrarlo
 * por el día de hoy lo haría desaparecer de la vista justo cuando más atrasado
 * está.
 */
envios.get('/', async (c) => {
  try {
    const estado = c.req.query('estado') || 'pendiente';
    const fecha = c.req.query('fecha');
    let q = db.from('envios_pendientes').select('*').eq('tenant_id', c.get('tenantId'));
    if (estado !== 'todos') q = q.eq('estado', estado);
    if (fecha) q = q.eq('fecha', fecha);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

envios.post('/', async (c) => {
  try {
    const p = EnvioSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return fail(c, 'Falta el cliente del envío', 422);
    const e = p.data;
    const yo = await quienEs(c);
    const { data, error } = await db.from('envios_pendientes').insert({
      tenant_id: c.get('tenantId'),
      cliente: e.cliente.trim(), customer_id: e.customer_id || null,
      telefono: e.telefono?.trim() || null, direccion: e.direccion?.trim() || null,
      detalle: e.detalle?.trim() || null, medio: e.medio,
      estado: 'pendiente', fecha: e.fecha || hoyCR(),
      registrado_por: yo.id, registrado_nombre: yo.nombre,
      impresion_id: e.impresion_id || null, notas: e.notas?.trim() || null,
    }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

envios.put('/:id', async (c) => {
  try {
    const p = EnvioSchema.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return fail(c, 'Datos inválidos', 422);
    const { data, error } = await db.from('envios_pendientes')
      .update({ ...p.data, updated_at: new Date().toISOString() })
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId')).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** POST /:id/estado — salió, llegó, se canceló. Queda firmado. */
envios.post('/:id/estado', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({}));
    const estado = String(b?.estado ?? '');
    if (!['pendiente', 'enviado', 'entregado', 'cancelado'].includes(estado)) {
      return fail(c, 'Estado inválido', 422);
    }
    const patch: any = { estado, updated_at: new Date().toISOString() };
    if (b?.guia !== undefined) patch.guia = String(b.guia ?? '').trim() || null;
    if (estado === 'enviado' || estado === 'entregado') {
      const yo = await quienEs(c);
      patch.despachado_por = yo.id;
      patch.despachado_nombre = yo.nombre;
      patch.despachado_at = new Date().toISOString();
    }
    const { data, error } = await db.from('envios_pendientes').update(patch)
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId')).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

envios.delete('/:id', async (c) => {
  try {
    const { error } = await db.from('envios_pendientes').delete()
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId'));
    if (error) throw new Error(error.message);
    return ok(c, { borrado: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ═══════════════════════════ CONTACTOS ═══════════════════════════

const ContactoSchema = z.object({
  cliente: z.string().min(1).max(200),
  customer_id: z.string().uuid().optional().nullable(),
  telefono: z.string().max(40).optional().nullable(),
  motivo: z.string().max(500).optional().nullable(),
  fecha: z.string().optional(),
});

envios.get('/contactos', async (c) => {
  try {
    const estado = c.req.query('estado') || 'pendiente';
    let q = db.from('contactos_pendientes').select('*').eq('tenant_id', c.get('tenantId'));
    if (estado !== 'todos') q = q.eq('estado', estado);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

envios.post('/contactos', async (c) => {
  try {
    const p = ContactoSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return fail(c, 'Falta el cliente', 422);
    const t = p.data;
    const yo = await quienEs(c);
    const { data, error } = await db.from('contactos_pendientes').insert({
      tenant_id: c.get('tenantId'),
      cliente: t.cliente.trim(), customer_id: t.customer_id || null,
      telefono: t.telefono?.trim() || null, motivo: t.motivo?.trim() || null,
      estado: 'pendiente', fecha: t.fecha || hoyCR(),
      registrado_por: yo.id, registrado_nombre: yo.nombre,
    }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * POST /contactos/:id/hecho — ya se le habló.
 *
 * Pide el RESULTADO. Un «hecho» sin resultado no sirve para nada: el que
 * pregunta mañana quiere saber qué contestó el cliente, no que alguien marcó
 * una casilla.
 */
envios.post('/contactos/:id/hecho', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({}));
    const yo = await quienEs(c);
    const { data, error } = await db.from('contactos_pendientes').update({
      estado: 'hecho',
      resultado: String(b?.resultado ?? '').trim() || null,
      hecho_por: yo.id, hecho_nombre: yo.nombre,
      hecho_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId')).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

envios.delete('/contactos/:id', async (c) => {
  try {
    const { error } = await db.from('contactos_pendientes').delete()
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId'));
    if (error) throw new Error(error.message);
    return ok(c, { borrado: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * GET /resumen — cuánto hay pendiente y de quién.
 *
 * El corte por empleado es el que convierte la lista en algo útil para el
 * dueño: ver que hay 12 envíos sin mandar es un dato; ver que 9 los anotó la
 * misma persona y nadie los ha despachado es una conversación.
 */
envios.get('/resumen', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const [{ data: env }, { data: con }] = await Promise.all([
      db.from('envios_pendientes').select('estado, registrado_nombre, despachado_nombre, fecha').eq('tenant_id', tenantId).limit(2000),
      db.from('contactos_pendientes').select('estado, registrado_nombre, fecha').eq('tenant_id', tenantId).limit(2000),
    ]);
    const hoy = hoyCR();
    const es = (env ?? []) as any[];
    const cs = (con ?? []) as any[];
    const porPersona: Record<string, { pendientes: number; despachados: number }> = {};
    for (const e of es) {
      const k = e.registrado_nombre || 'Sin nombre';
      porPersona[k] ??= { pendientes: 0, despachados: 0 };
      if (e.estado === 'pendiente') porPersona[k].pendientes += 1;
      if (e.despachado_nombre) {
        const d = e.despachado_nombre;
        porPersona[d] ??= { pendientes: 0, despachados: 0 };
        porPersona[d].despachados += 1;
      }
    }
    return ok(c, {
      envios: {
        pendientes: es.filter(e => e.estado === 'pendiente').length,
        atrasados: es.filter(e => e.estado === 'pendiente' && String(e.fecha) < hoy).length,
        enviados_hoy: es.filter(e => e.estado !== 'pendiente' && String(e.fecha) === hoy).length,
      },
      contactos: {
        pendientes: cs.filter(x => x.estado === 'pendiente').length,
        atrasados: cs.filter(x => x.estado === 'pendiente' && String(x.fecha) < hoy).length,
      },
      por_persona: Object.entries(porPersona)
        .map(([nombre, v]) => ({ nombre, ...v }))
        .sort((a, b) => b.pendientes - a.pendientes),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default envios;
