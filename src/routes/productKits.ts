import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * Kits de productos (combos / paquetes). Ver migrations/93_product_kits.sql
 *
 * El kit es un producto vendible normal; lo que cambia es que al venderlo el
 * inventario baja por sus COMPONENTES. Acá se administra su composición.
 */
const productKits = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const ItemSchema = z.object({
  component_id: z.string().uuid(),
  quantity: z.number().positive(),
});

/** Componentes de varios kits de una sola consulta (evita N+1). */
async function itemsOf(tenantId: string, kitIds: string[]) {
  if (!kitIds.length) return new Map<string, any[]>();
  const { data } = await db.from('product_kit_items')
    .select('id, kit_id, component_id, quantity')
    .eq('tenant_id', tenantId).in('kit_id', kitIds);
  const compIds = [...new Set((data ?? []).map((r: any) => r.component_id))];
  const { data: comps } = compIds.length
    ? await db.from('products')
        .select('id, name, sku, unit_price, cost_price, stock_quantity, tracks_stock')
        .eq('tenant_id', tenantId).in('id', compIds)
    : { data: [] as any[] };
  const byId = new Map((comps ?? []).map((p: any) => [String(p.id), p]));
  const out = new Map<string, any[]>();
  for (const r of (data ?? []) as any[]) {
    const p = byId.get(String(r.component_id));
    const list = out.get(String(r.kit_id)) ?? [];
    list.push({
      id: r.id, component_id: r.component_id, quantity: Number(r.quantity),
      name: p?.name ?? 'Producto eliminado', sku: p?.sku ?? null,
      price: Number(p?.unit_price ?? 0), cost_price: Number(p?.cost_price ?? 0),
      stock_quantity: Number(p?.stock_quantity ?? 0),
      tracks_stock: p?.tracks_stock !== false,
    });
    out.set(String(r.kit_id), list);
  }
  return out;
}

/** Cuántos kits se pueden armar con el stock que hay hoy. */
function buildable(items: any[]): number | null {
  const limited = items.filter(i => i.tracks_stock);
  if (!limited.length) return null;                 // todo stock infinito
  return Math.floor(Math.min(...limited.map(i => i.stock_quantity / i.quantity)));
}

// GET / — kits del negocio, con su composición, costo y cuántos se pueden armar.
productKits.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    let { data: kits, error } = await db.from('products')
      .select('id, name, sku, unit_price, cost_price, category_id, image_url')
      .eq('tenant_id', tenantId).eq('is_kit', true)
      .is('deleted_at', null)
      .order('name');
    // Sin la migración 93 la columna no existe todavía: se responde lista vacía
    // en vez de un 500, así la pantalla abre y el catálogo se puede ver.
    if (error && /is_kit|product_kit_items/i.test(error.message)) {
      return ok(c, []);
    }
    if (error && /deleted_at/i.test(error.message)) {
      const retry = await db.from('products')
        .select('id, name, sku, unit_price, cost_price, category_id, image_url')
        .eq('tenant_id', tenantId).eq('is_kit', true).order('name');
      if (retry.error) throw new Error(retry.error.message);
      kits = retry.data;
    } else if (error) throw new Error(error.message);

    const ids = (kits ?? []).map((k: any) => String(k.id));
    const items = await itemsOf(tenantId, ids);
    return ok(c, (kits ?? []).map((k: any) => {
      const its = items.get(String(k.id)) ?? [];
      const cost = its.reduce((s, i) => s + i.cost_price * i.quantity, 0);
      const loose = its.reduce((s, i) => s + i.price * i.quantity, 0);
      return {
        ...k,
        // El front trabaja con `price`; en la tabla la columna es `unit_price`.
        price: Number((k as any).unit_price ?? 0),
        items: its,
        // Costo real del kit = suma de costos de lo que lleva dentro.
        components_cost: Math.round(cost * 100) / 100,
        // Lo que costaría comprando cada cosa por aparte: sirve para mostrar el
        // ahorro y para no poner el kit más caro que sus partes por descuido.
        loose_price: Math.round(loose * 100) / 100,
        buildable: buildable(its),
      };
    }));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id — un kit con su composición.
productKits.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const { data: kit } = await db.from('products')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!kit) return fail(c, 'Kit no encontrado', 404);
    const items = (await itemsOf(tenantId, [id])).get(id) ?? [];
    return ok(c, {
      ...(kit as any), price: Number((kit as any).unit_price ?? 0),
      items, buildable: buildable(items),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /:id/items — define la composición del kit (reemplaza la anterior).
productKits.put('/:id/items', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));
    const parsed = z.array(ItemSchema).min(1).safeParse(body?.items);
    if (!parsed.success) return fail(c, 'El kit necesita al menos un producto: ' + parsed.error.message, 422);

    const { data: kit } = await db.from('products')
      .select('id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!kit) return fail(c, 'Kit no encontrado', 404);

    // Un kit dentro de sí mismo se descontaría en ciclo al vender.
    if (parsed.data.some(i => i.component_id === id)) {
      return fail(c, 'Un kit no puede contenerse a sí mismo', 422);
    }
    // Y un kit dentro de otro kit tampoco: el descuento en cadena no está
    // soportado y dejaría el inventario mintiendo.
    const { data: nested } = await db.from('products')
      .select('id, name').eq('tenant_id', tenantId).eq('is_kit', true)
      .in('id', parsed.data.map(i => i.component_id));
    if (nested?.length) {
      return fail(c, `No se puede meter un kit dentro de otro: ${(nested as any[]).map(n => n.name).join(', ')}`, 422);
    }

    const { error: delErr } = await db.from('product_kit_items').delete()
      .eq('tenant_id', tenantId).eq('kit_id', id);
    if (delErr) throw new Error(delErr.message);

    const { error: insErr } = await db.from('product_kit_items').insert(
      parsed.data.map(i => ({ tenant_id: tenantId, kit_id: id, ...i })));
    if (insErr) throw new Error(insErr.message);

    await db.from('products').update({ is_kit: true, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId);

    const items = (await itemsOf(tenantId, [id])).get(id) ?? [];
    return ok(c, { id, items, buildable: buildable(items) });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/convert — marca un producto existente como kit (o lo devuelve a
// producto normal con `is_kit: false`).
productKits.post('/:id/convert', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));
    const isKit = body?.is_kit !== false;

    const patch: any = { is_kit: isKit, updated_at: new Date().toISOString() };
    // El stock del kit no se lleva: lo que hay son los componentes. Dejarlo
    // rastreando stock haría que el POS bloqueara la venta por falta de un
    // stock que nunca se va a mover.
    if (isKit) patch.tracks_stock = false;

    const { data, error } = await db.from('products').update(patch)
      .eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);

    if (!isKit) {
      await db.from('product_kit_items').delete().eq('tenant_id', tenantId).eq('kit_id', id);
    }
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default productKits;
