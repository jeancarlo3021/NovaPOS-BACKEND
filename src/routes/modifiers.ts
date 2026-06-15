import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const modifiers = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const GroupSchema = z.object({
  product_id: z.string().uuid(),
  name:       z.string().min(1),
  min_select: z.number().int().min(0).optional().default(0),
  max_select: z.number().int().min(1).optional().default(1),
  sort_order: z.number().int().optional().default(0),
  modifiers:  z.array(z.object({
    name:        z.string().min(1),
    price_delta: z.number().optional().default(0),
    sort_order:  z.number().int().optional().default(0),
  })).optional().default([]),
});

// GET /?product_id=xxx — grupos + opciones de un producto
modifiers.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return ok(c, []);
    const productId = c.req.query('product_id');

    let gq = db.from('product_modifier_groups')
      .select('*').eq('tenant_id', tenantId).order('sort_order');
    if (productId) gq = gq.eq('product_id', productId);
    const { data: groups, error: gErr } = await gq;
    if (gErr) throw new Error(gErr.message);

    const groupIds = (groups ?? []).map((g: any) => g.id);
    let opts: any[] = [];
    if (groupIds.length > 0) {
      const { data, error } = await db.from('product_modifiers')
        .select('*').in('group_id', groupIds).order('sort_order');
      if (error) throw new Error(error.message);
      opts = data ?? [];
    }

    const result = (groups ?? []).map((g: any) => ({
      ...g,
      modifiers: opts.filter(o => o.group_id === g.id),
    }));
    return ok(c, result);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /product/:productId — reemplaza TODOS los grupos+opciones de un producto
modifiers.put('/product/:productId', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return fail(c, 'Sin tenant', 400);
    const { productId } = c.req.param();
    const body = await c.req.json();
    const groups = z.array(GroupSchema).parse(body.groups ?? []);

    // Borrar grupos viejos (cascade borra opciones)
    await db.from('product_modifier_groups')
      .delete().eq('tenant_id', tenantId).eq('product_id', productId);

    for (const g of groups) {
      const { data: gRow, error: gErr } = await db.from('product_modifier_groups')
        .insert({
          tenant_id:  tenantId,
          product_id: productId,
          name:       g.name,
          min_select: g.min_select,
          max_select: g.max_select,
          sort_order: g.sort_order,
        }).select().single();
      if (gErr) throw new Error(gErr.message);

      if (g.modifiers.length > 0) {
        const rows = g.modifiers.map((m, i) => ({
          group_id:    gRow.id,
          name:        m.name,
          price_delta: m.price_delta ?? 0,
          sort_order:  m.sort_order ?? i,
        }));
        const { error: mErr } = await db.from('product_modifiers').insert(rows);
        if (mErr) throw new Error(mErr.message);
      }
    }
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default modifiers;
