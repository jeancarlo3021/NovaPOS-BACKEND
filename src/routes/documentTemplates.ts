import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const documentTemplates = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/**
 * PLANTILLAS DE DOCUMENTO: tiquete, hoja (PDF) y proforma.
 *
 * Lo único que se podía cambiar del papel eran unos interruptores y el mensaje
 * del pie. Dónde va el logo, qué columnas lleva el detalle, cómo se titula el
 * documento o las condiciones de una cotización estaban escritos en el código,
 * iguales para todos los negocios.
 *
 * El DISEÑO viaja como JSON y no se valida pieza por pieza: el editor agrega
 * propiedades seguido (rotación, auto-ajuste, fondos) y un esquema estricto
 * acá significaría que una plantilla guardada con el editor nuevo se rechaza
 * hasta que alguien actualice el servidor. Lo que SÍ se valida es lo que el
 * servidor usa o muestra: el tipo de documento, el nombre y las medidas.
 */
const KINDS = ['ticket', 'hoja', 'proforma'] as const;

const PlantillaSchema = z.object({
  kind: z.enum(KINDS),
  name: z.string().min(1).max(120),
  /* Medidas en mm, con tope: una hoja de 4 metros es un dedazo y deja al
     editor dibujando un lienzo que no cabe en memoria. */
  width_mm: z.number().positive().max(1000).optional().default(216),
  height_mm: z.number().positive().max(2000).nullable().optional(),
  is_default: z.boolean().optional(),
  design: z.record(z.any()).optional().default({}),
});

const aSalida = (f: any) => ({
  id: String(f.id),
  kind: f.kind as (typeof KINDS)[number],
  name: f.name,
  isDefault: !!f.is_default,
  widthMm: Number(f.width_mm),
  heightMm: f.height_mm === null || f.height_mm === undefined ? null : Number(f.height_mm),
  design: (f.design && typeof f.design === 'object') ? f.design : {},
  updatedAt: f.updated_at,
});

/**
 * Deja UNA sola predeterminada por tipo.
 *
 * La base lo garantiza con un índice único parcial, así que sin apagar las
 * otras primero el insert/update FALLA por conflicto en vez de guardar. Se
 * apagan antes de marcar, no después: al revés quedaría un instante con dos
 * marcadas, y es justo el instante en que otro usuario puede imprimir.
 */
async function apagarOtrasDefault(tenantId: string, kind: string, exceptoId?: string) {
  let q = db.from('document_templates')
    .update({ is_default: false, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId).eq('kind', kind).eq('is_default', true);
  if (exceptoId) q = q.neq('id', exceptoId);
  await q;
}

/** GET /?kind=ticket — las plantillas del negocio, opcionalmente de un tipo. */
documentTemplates.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const kind = c.req.query('kind');
    let q = db.from('document_templates')
      .select('*').eq('tenant_id', tenantId)
      .order('updated_at', { ascending: false });
    if (kind) {
      if (!KINDS.includes(kind as any)) return fail(c, 'Tipo de documento inválido', 422);
      q = q.eq('kind', kind);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ok(c, ((data ?? []) as any[]).map(aSalida));
  } catch (err: any) { return fail(c, err.message, 500); }
});

documentTemplates.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data, error } = await db.from('document_templates')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Plantilla no encontrada', 404);
    return ok(c, aSalida(data));
  } catch (err: any) { return fail(c, err.message, 500); }
});

documentTemplates.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = PlantillaSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.errors[0]?.message ?? 'Datos inválidos', 422);
    const p = parsed.data;

    if (p.is_default) await apagarOtrasDefault(tenantId, p.kind);

    const { data, error } = await db.from('document_templates').insert({
      tenant_id: tenantId,
      kind: p.kind,
      name: p.name.trim(),
      is_default: !!p.is_default,
      width_mm: p.width_mm ?? 216,
      height_mm: p.height_mm ?? null,
      design: p.design ?? {},
    }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, aSalida(data), 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

documentTemplates.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const parsed = PlantillaSchema.partial().safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.errors[0]?.message ?? 'Datos inválidos', 422);
    const p = parsed.data as any;

    /* El tipo no se cambia después: un diseño hecho para un rollo de 72 mm no
       es una hoja carta, y "convertirlo" dejaría todos los elementos fuera del
       papel sin decir nada. Se duplica y se rediseña. */
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (p.name !== undefined) patch.name = String(p.name).trim();
    if (p.width_mm !== undefined) patch.width_mm = p.width_mm;
    if (p.height_mm !== undefined) patch.height_mm = p.height_mm;
    if (p.design !== undefined) patch.design = p.design;
    if (p.is_default !== undefined) patch.is_default = !!p.is_default;

    if (Object.keys(patch).length === 1) return fail(c, 'No llegó ningún cambio.', 422);

    if (p.is_default === true) {
      /* Hay que saber de qué TIPO es para apagar solo las de su tipo: apagar
         por tenant dejaría al tiquete sin predeterminada por marcar una
         proforma. */
      const { data: actual } = await db.from('document_templates')
        .select('kind').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
      if (!actual) return fail(c, 'Plantilla no encontrada', 404);
      await apagarOtrasDefault(tenantId, (actual as any).kind, id);
    }

    const { data, error } = await db.from('document_templates')
      .update(patch).eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) {
      if ((error as any).code === 'PGRST116') return fail(c, 'Plantilla no encontrada', 404);
      throw new Error(error.message);
    }
    return ok(c, aSalida(data));
  } catch (err: any) { return fail(c, err.message, 500); }
});

documentTemplates.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db.from('document_templates')
      .delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default documentTemplates;
