import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const labelTemplates = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/**
 * PLANTILLAS DE ETIQUETAS.
 *
 * Son del NEGOCIO y no del equipo: antes vivían en el localStorage del
 * navegador, así que la plantilla existía en una sola computadora y se perdía
 * al limpiar el caché. Diseñar una etiqueta de 40×30 con su código de barras
 * bien puesto toma media hora.
 *
 * El DISEÑO viaja como JSON y no se valida pieza por pieza: el editor agrega
 * propiedades nuevas seguido (rotación, auto-ajuste, imágenes) y un esquema
 * estricto acá significaría que una plantilla guardada con la versión nueva del
 * editor se rechaza hasta que alguien actualice el servidor. Lo que SÍ se
 * valida es lo que el servidor usa o muestra: nombre, medidas y que los
 * elementos sean una lista.
 */
const PlantillaSchema = z.object({
  name: z.string().min(1).max(120),
  /* Medidas en milímetros, con tope: una etiqueta de 4 metros es un dedazo, y
     deja al editor dibujando un lienzo que no cabe en memoria. */
  width_mm: z.number().positive().max(500),
  height_mm: z.number().positive().max(500),
  border: z.boolean().optional().default(false),
  elements: z.array(z.any()).max(200).optional().default([]),
});

const aSalida = (f: any) => ({
  id: String(f.id),
  name: f.name,
  widthMm: Number(f.width_mm),
  heightMm: Number(f.height_mm),
  border: !!f.border,
  elements: Array.isArray(f.elements) ? f.elements : [],
  updatedAt: f.updated_at,
});

labelTemplates.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('label_templates')
      .select('*').eq('tenant_id', tenantId)
      .order('updated_at', { ascending: false });
    if (error) throw new Error(error.message);
    return ok(c, ((data ?? []) as any[]).map(aSalida));
  } catch (err: any) { return fail(c, err.message, 500); }
});

labelTemplates.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data, error } = await db.from('label_templates')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Plantilla no encontrada', 404);
    return ok(c, aSalida(data));
  } catch (err: any) { return fail(c, err.message, 500); }
});

labelTemplates.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = PlantillaSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const p = parsed.data;

    const { data, error } = await db.from('label_templates').insert({
      tenant_id: tenantId,
      name: p.name.trim(),
      width_mm: p.width_mm, height_mm: p.height_mm,
      border: p.border ?? false,
      elements: p.elements ?? [],
    }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, aSalida(data), 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

labelTemplates.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const parsed = PlantillaSchema.partial().safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const p = parsed.data as any;

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (p.name !== undefined) patch.name = String(p.name).trim();
    if (p.width_mm !== undefined) patch.width_mm = p.width_mm;
    if (p.height_mm !== undefined) patch.height_mm = p.height_mm;
    if (p.border !== undefined) patch.border = p.border;
    if (p.elements !== undefined) patch.elements = p.elements;

    /* Solo `updated_at` significa que no llegó nada que cambiar: guardar eso
       sería decir «guardado» sin haber guardado el diseño. */
    if (Object.keys(patch).length === 1) return fail(c, 'No llegó ningún cambio.', 422);

    const { data, error } = await db.from('label_templates')
      .update(patch).eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) {
      if ((error as any).code === 'PGRST116') return fail(c, 'Plantilla no encontrada', 404);
      throw new Error(error.message);
    }
    return ok(c, aSalida(data));
  } catch (err: any) { return fail(c, err.message, 500); }
});

labelTemplates.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db.from('label_templates')
      .delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default labelTemplates;
