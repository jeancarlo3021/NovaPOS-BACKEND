import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { cargarComposicion, expandir, buscarCiclo, profundidadDe, PROFUNDIDAD_MAX } from '../services/kits.js';

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
        .select('id, name, sku, unit_price, cost_price, stock_quantity, tracks_stock, is_kit')
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
      // Un componente puede ser OTRO KIT. La pantalla lo marca para que se vea
      // que ahí abajo todavía hay más, y el stock del sub-kit no significa
      // nada: lo que manda es lo que él lleva adentro.
      is_kit: (p as any)?.is_kit === true,
    });
    out.set(String(r.kit_id), list);
  }
  return out;
}

/**
 * Cuántos kits se pueden armar con el stock de hoy, mirando TODA la cadena.
 *
 * Con sub-kits, contar solo los componentes directos daría un número inventado:
 * un «Combo familiar» que lleva tres «Combo chico» no se limita por el stock
 * del combo chico —que no existe, un kit no tiene existencias— sino por los
 * refrescos que hay al final de la cadena.
 */
function armables(hojas: Map<string, number>, stockPorId: Map<string, { stock: number; rastrea: boolean }>): number | null {
  const limitados = [...hojas.entries()].filter(([id]) => stockPorId.get(id)?.rastrea !== false);
  if (!limitados.length) return null;               // todo stock infinito
  return Math.floor(Math.min(...limitados.map(([id, qty]) =>
    (stockPorId.get(id)?.stock ?? 0) / (qty || 1))));
}

/**
 * Stock, costo y nombre de todo lo que puede ser hoja de algún kit.
 *
 * Una sola consulta para toda la pantalla: con sub-kits, cada kit puede tocar
 * productos que no son suyos y preguntarlos uno por uno multiplicaría los
 * viajes a la base por la profundidad de la cadena.
 */
async function stockDeHojas(tenantId: string, kitIds: string[], comp: any) {
  const necesarios = new Set<string>();
  for (const id of kitIds) for (const hoja of expandir(id, 1, comp).keys()) necesarios.add(hoja);
  const mapa = new Map<string, { stock: number; rastrea: boolean; costo: number; nombre: string }>();
  if (!necesarios.size) return mapa;
  const { data } = await db.from('products')
    .select('id, name, cost_price, stock_quantity, tracks_stock')
    .eq('tenant_id', tenantId).in('id', [...necesarios]);
  for (const p of (data ?? []) as any[]) {
    mapa.set(String(p.id), {
      stock: Number(p.stock_quantity ?? 0),
      rastrea: p.tracks_stock !== false,
      costo: Number(p.cost_price ?? 0),
      nombre: p.name,
    });
  }
  return mapa;
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
    const comp = await cargarComposicion(tenantId);
    const stockPorId = await stockDeHojas(tenantId, ids, comp);

    return ok(c, (kits ?? []).map((k: any) => {
      const its = items.get(String(k.id)) ?? [];
      const hojas = expandir(String(k.id), 1, comp);
      /*
       * El COSTO sale de las hojas, no de los componentes directos.
       *
       * Un sub-kit no tiene costo propio —su `cost_price` suele estar en cero,
       * porque nunca se compra: se arma—. Sumando el directo, un kit hecho de
       * kits costaba ₡0 y el margen salía del 100%.
       */
      const cost = [...hojas.entries()].reduce(
        (s, [id, qty]) => s + (stockPorId.get(id)?.costo ?? 0) * qty, 0);
      // El suelto SÍ es por componente directo: es lo que pagaría el cliente
      // comprando cada cosa por separado, y un sub-kit se vende como tal.
      const loose = its.reduce((s, i) => s + i.price * i.quantity, 0);
      return {
        ...k,
        // El front trabaja con `price`; en la tabla la columna es `unit_price`.
        price: Number((k as any).unit_price ?? 0),
        items: its,
        components_cost: Math.round(cost * 100) / 100,
        loose_price: Math.round(loose * 100) / 100,
        buildable: armables(hojas, stockPorId),
        /** Niveles de kit dentro de kit: 1 = solo productos sueltos. */
        depth: profundidadDe(String(k.id), comp),
        /** Lo que de verdad se descuenta al vender uno. */
        leaves: [...hojas.entries()].map(([id, qty]) => ({
          product_id: id, quantity: Math.round(qty * 1000) / 1000,
          name: stockPorId.get(id)?.nombre ?? 'Producto eliminado',
          stock_quantity: stockPorId.get(id)?.stock ?? 0,
          tracks_stock: stockPorId.get(id)?.rastrea !== false,
        })),
      };
    }));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /search?q=... — busca productos vendidos como kit (por nombre o SKU).
// Pensado para elegir un sub-kit al armar la composición de otro.
productKits.get('/search', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const q = (c.req.query('q') ?? '').trim();
    const excludeId = c.req.query('exclude_id');
    const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 50);

    let query = db.from('products')
      .select('id, name, sku, unit_price, cost_price, image_url')
      .eq('tenant_id', tenantId).eq('is_kit', true)
      .is('deleted_at', null);

    if (q) {
      const safe = q.replace(/[%,]/g, ' ');
      query = query.or(`name.ilike.%${safe}%,sku.ilike.%${safe}%`);
    }
    if (excludeId) query = query.neq('id', excludeId);

    const { data, error } = await query.order('name').limit(limit);
    if (error && /is_kit/i.test(error.message)) return ok(c, []);
    if (error && /deleted_at/i.test(error.message)) {
      let retry = db.from('products')
        .select('id, name, sku, unit_price, cost_price, image_url')
        .eq('tenant_id', tenantId).eq('is_kit', true);
      if (q) {
        const safe = q.replace(/[%,]/g, ' ');
        retry = retry.or(`name.ilike.%${safe}%,sku.ilike.%${safe}%`);
      }
      if (excludeId) retry = retry.neq('id', excludeId);
      const r = await retry.order('name').limit(limit);
      if (r.error) throw new Error(r.error.message);
      return ok(c, (r.data ?? []).map((k: any) => ({ ...k, price: Number(k.unit_price ?? 0) })));
    }
    if (error) throw new Error(error.message);

    return ok(c, (data ?? []).map((k: any) => ({ ...k, price: Number(k.unit_price ?? 0) })));
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
    const comp = await cargarComposicion(tenantId);
    const hojas = expandir(id, 1, comp);
    const stockPorId = await stockDeHojas(tenantId, [id], comp);
    return ok(c, {
      ...(kit as any), price: Number((kit as any).unit_price ?? 0),
      items,
      buildable: armables(hojas, stockPorId),
      depth: profundidadDe(id, comp),
      leaves: [...hojas.entries()].map(([pid, qty]) => ({
        product_id: pid, quantity: Math.round(qty * 1000) / 1000,
        name: stockPorId.get(pid)?.nombre ?? 'Producto eliminado',
        stock_quantity: stockPorId.get(pid)?.stock ?? 0,
        tracks_stock: stockPorId.get(pid)?.rastrea !== false,
      })),
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

    /*
     * SUB-KITS: un componente puede ser otro kit.
     *
     * Antes estaba prohibido porque al vender se descontaba un solo nivel y el
     * inventario quedaba mintiendo. Ahora la venta baja por toda la cadena
     * (`services/kits.ts`), así que lo único que hay que impedir es lo que no
     * tiene sentido físico: que un kit termine conteniéndose a sí mismo, en
     * forma directa o dando la vuelta por otros.
     */
    const comp = await cargarComposicion(tenantId);
    const ciclo = buscarCiclo(id, parsed.data, comp);
    if (ciclo) {
      const { data: nombres } = await db.from('products')
        .select('id, name').eq('tenant_id', tenantId).in('id', ciclo);
      const porId = new Map((nombres ?? []).map((p: any) => [String(p.id), p.name]));
      const ruta = ciclo.map(x => porId.get(String(x)) ?? 'kit').join(' → ');
      return fail(c, ciclo.length <= 2
        ? 'Un kit no puede contenerse a sí mismo'
        : `Eso arma un círculo sin fin: ${ruta}`, 422);
    }
    /*
     * Y un límite de profundidad: seis niveles de kit dentro de kit es más de
     * lo que cualquier combo real necesita, y más abajo lo normal es que sea un
     * error de carga que nadie va a poder desenredar después.
     */
    const futura = {
      ...comp,
      directos: new Map(comp.directos).set(id, parsed.data.map(i => ({
        component_id: String(i.component_id), quantity: i.quantity,
      }))),
      esKit: new Set(comp.esKit).add(id),
    };
    if (profundidadDe(id, futura) > PROFUNDIDAD_MAX) {
      return fail(c, `Demasiados kits encadenados (máximo ${PROFUNDIDAD_MAX} niveles).`, 422);
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
    const tras = await cargarComposicion(tenantId);
    const hojas = expandir(id, 1, tras);
    return ok(c, { id, items, buildable: armables(hojas, await stockDeHojas(tenantId, [id], tras)) });
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
