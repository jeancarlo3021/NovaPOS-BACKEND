import { db } from '../db/client.js';
import { cargarComposicion, expandirConCambios } from './kits.js';
import { consumeForInvoice, applyConsumption, revertConsumption } from './recipeConsumption.js';

/**
 * EL INVENTARIO DE UNA VENTA: lo que baja al vender y lo que vuelve al anular.
 *
 * Vivía dentro de la ruta de facturas, así que el POS ELECTRÓNICO —que emite
 * por otro camino (`/hacienda/emit-direct`)— vendía sin tocar el inventario: el
 * negocio facturaba a Hacienda y sus existencias quedaban intactas. Lo mismo
 * con la nota de crédito, que anula la venta ante Hacienda pero dejaba la
 * mercadería descontada.
 *
 * Acá está una sola vez y lo usan los dos lados. Si mañana cambia la regla de
 * los kits o de las recetas, cambia para todos a la vez.
 */

export interface LineaVenta {
  product_id?: string | null;
  quantity: number;
  kit_substitutions?: Array<{ from: string; to: string }> | null;
}

/**
 * Baja de inventario de varias líneas a la vez.
 *
 * Una por una eran DOS viajes a la base por línea (leer y escribir): una
 * factura de 40 líneas se iba a más de diez segundos y el POS cortaba por
 * tiempo. Acá se lee todo de una consulta y las bajas van de a 6 en paralelo.
 *
 * Las cantidades del mismo producto se suman antes: dos escrituras sobre la
 * misma fila se pisan y una de las bajas se pierde.
 */
export async function descontarStock(lineas: Array<{ id: string; qty: number }>): Promise<void> {
  if (lineas.length === 0) return;

  const porProducto = new Map<string, number>();
  for (const l of lineas) {
    if (!l.id || !Number.isFinite(l.qty)) continue;
    porProducto.set(l.id, (porProducto.get(l.id) ?? 0) + Number(l.qty));
  }
  const ids = [...porProducto.keys()];
  if (ids.length === 0) return;

  const { data: prods } = await db.from('products')
    .select('id, stock_quantity, tracks_stock').in('id', ids);

  const pendientes = (prods ?? []).filter((p: any) => p.tracks_stock !== false);
  const ahora = new Date().toISOString();

  const CONCURRENCIA = 6;
  for (let i = 0; i < pendientes.length; i += CONCURRENCIA) {
    await Promise.all(pendientes.slice(i, i + CONCURRENCIA).map((p: any) =>
      db.from('products').update({
        stock_quantity: Math.max(0, Number(p.stock_quantity ?? 0) - (porProducto.get(String(p.id)) ?? 0)),
        updated_at: ahora,
      }).eq('id', p.id)));
  }
}

export interface ResultadoDescuento {
  /** Platos cuyo inventario se movió por sus INGREDIENTES (receta). */
  recipeProductIds: Set<string>;
  /** Kits cuyo inventario se movió por sus COMPONENTES. */
  kitProductIds: Set<string>;
  /** Costo por producto que dejó el cálculo de recetas (para congelarlo). */
  costByProduct: Map<string, number>;
}

/**
 * Descuenta el inventario de una venta ya creada.
 *
 * Tres casos, en este orden:
 *  1. RECETAS — el plato no se descuenta: se descuentan sus ingredientes.
 *  2. KITS — el kit no se descuenta: se descuentan sus componentes, por toda
 *     la cadena (un combo que lleva combos termina bajando los refrescos).
 *  3. Lo demás, directo.
 *
 * Nada de esto puede tumbar la venta: el cliente ya pagó y la factura ya
 * existe. Los fallos quedan en el registro del servidor.
 */
export async function descontarVenta(
  tenantId: string, invoiceId: string, items: any[],
): Promise<ResultadoDescuento> {
  let recipeProductIds = new Set<string>();
  let costByProduct = new Map<string, number>();
  const kitProductIds = new Set<string>();

  // 1) Recetas.
  try {
    const r = await consumeForInvoice(tenantId, invoiceId, items);
    recipeProductIds = r.recipeProductIds;
    costByProduct = r.costByProduct;
    if (r.lines.length) await applyConsumption(tenantId, r.lines, { invoice_id: invoiceId });
  } catch (e: any) {
    console.warn('[venta] no se pudo aplicar el consumo de recetas:', e?.message);
  }

  // 2) Kits.
  try {
    const ids = items.map(i => i.product_id).filter(Boolean).map(String);
    if (ids.length) {
      const comp = await cargarComposicion(tenantId);
      const vendidos = ids.filter(id => comp.esKit.has(id) && (comp.directos.get(id)?.length ?? 0) > 0);
      if (vendidos.length) {
        const need = new Map<string, number>();
        for (const item of items) {
          const id = String(item.product_id ?? '');
          if (!vendidos.includes(id)) continue;
          kitProductIds.add(id);
          for (const [hoja, qty] of expandirConCambios(
            id, Number(item.quantity), comp, item.kit_substitutions ?? [])) {
            need.set(hoja, (need.get(hoja) ?? 0) + qty);
          }
        }
        await descontarStock([...need.entries()].map(([id, qty]) => ({ id, qty })));
      }
    }
  } catch (e: any) { console.warn('[venta] no se pudieron descontar los componentes del kit:', e?.message); }

  // 3) El resto. Los de stock infinito (`tracks_stock === false`) no se tocan.
  await descontarStock(items
    .filter(item => item.product_id
      && !kitProductIds.has(String(item.product_id))
      && !recipeProductIds.has(String(item.product_id)))
    .map(item => ({ id: String(item.product_id), qty: Number(item.quantity) })));

  return { recipeProductIds, kitProductIds, costByProduct };
}

export interface ResultadoDevolucion {
  /** Cuántas líneas devolvieron mercadería. */
  devueltas: number;
  /** Líneas que no se pudieron devolver, con su motivo. */
  saltadas: string[];
}

/**
 * Devuelve al inventario lo que una venta se había llevado.
 *
 * Se usa al ANULAR y al emitir una NOTA DE CRÉDITO: en los dos casos la venta
 * deja de existir y la mercadería vuelve a estar disponible. Devuelve por el
 * MISMO camino por el que bajó —ingredientes de la receta, componentes del kit,
 * o el producto— porque si no, el inventario queda mintiendo en la otra punta.
 *
 * `truckWarehouseId`: venta de ruta. El stock salió del camión, no de la
 * bodega; devolverlo a `products` inflaría el inventario general y dejaría al
 * camión corto.
 */
export async function devolverVenta(
  tenantId: string, invoiceId: string, opts?: { truckWarehouseId?: string | null },
): Promise<ResultadoDevolucion> {
  const truckId = opts?.truckWarehouseId ?? null;

  // 1) Recetas: vuelven los INGREDIENTES, no el plato (el plato nunca bajó).
  const recipeReturned = new Set<string>();
  try {
    const { data: cons } = await db.from('recipe_consumptions')
      .select('product_id').eq('tenant_id', tenantId).eq('invoice_id', invoiceId).is('reverted_at', null);
    if (cons?.length) {
      await revertConsumption(tenantId, invoiceId);
      const { data: sold } = await db.from('invoice_items')
        .select('product_id').eq('invoice_id', invoiceId);
      const { data: recs } = await db.from('recipes')
        .select('product_id').eq('tenant_id', tenantId).not('product_id', 'is', null);
      const withRecipe = new Set((recs ?? []).map((r: any) => String(r.product_id)));
      for (const s of (sold ?? []) as any[]) {
        if (s.product_id && withRecipe.has(String(s.product_id))) recipeReturned.add(String(s.product_id));
      }
    }
  } catch (e: any) { console.warn('[devolución] consumo de recetas:', e?.message); }

  // Sin la migración 124 la columna `kit_substitutions` no existe: se vuelve a
  // pedir sin ella y la devolución se hace con la receta original del kit.
  let { data: items } = await db.from('invoice_items')
    .select('product_id, quantity, kit_substitutions').eq('invoice_id', invoiceId);
  if (!items) {
    const r = await db.from('invoice_items').select('product_id, quantity').eq('invoice_id', invoiceId);
    items = r.data as any;
  }

  // 2) Kits: vuelven los COMPONENTES.
  const kitReturned = new Set<string>();
  try {
    const ids = (items ?? []).map((i: any) => String(i.product_id)).filter(Boolean);
    if (ids.length) {
      const comp = await cargarComposicion(tenantId);
      const devueltos = ids.filter(id => comp.esKit.has(id) && (comp.directos.get(id)?.length ?? 0) > 0);
      if (devueltos.length) {
        const back = new Map<string, number>();
        for (const it of (items ?? []) as any[]) {
          const id = String(it.product_id ?? '');
          if (!devueltos.includes(id)) continue;
          kitReturned.add(id);
          for (const [hoja, qty] of expandirConCambios(
            id, Number(it.quantity), comp, (it as any).kit_substitutions ?? [])) {
            back.set(hoja, (back.get(hoja) ?? 0) + qty);
          }
        }
        for (const [componentId, qty] of back) {
          const { data: p } = await db.from('products')
            .select('stock_quantity, tracks_stock').eq('id', componentId).maybeSingle();
          if (p && (p as any).tracks_stock !== false) {
            await db.from('products').update({
              stock_quantity: Number((p as any).stock_quantity ?? 0) + qty,
              updated_at: new Date().toISOString(),
            }).eq('id', componentId);
          }
        }
      }
    }
  } catch (e: any) { console.warn('[devolución] componentes del kit:', e?.message); }

  // 3) El resto.
  let devueltas = 0;
  const saltadas: string[] = [];
  for (const it of (items ?? []) as any[]) {
    if (!it.product_id) { saltadas.push('línea sin producto'); continue; }
    if (recipeReturned.has(String(it.product_id))) continue;
    if (kitReturned.has(String(it.product_id))) continue;

    if (truckId) {
      const { data: row } = await db.from('warehouse_stock')
        .select('quantity').eq('warehouse_id', truckId).eq('product_id', it.product_id).maybeSingle();
      const up = await db.from('warehouse_stock').upsert({
        warehouse_id: truckId, product_id: it.product_id,
        quantity: Number((row as any)?.quantity ?? 0) + Number(it.quantity),
      }, { onConflict: 'warehouse_id,product_id' });
      if (up.error) { console.warn('[devolución] camión:', up.error.message); saltadas.push(String(it.product_id)); }
      else devueltas++;
      continue;
    }

    const { data: p, error: readP } = await db.from('products')
      .select('stock_quantity, tracks_stock').eq('id', it.product_id).eq('tenant_id', tenantId).maybeSingle();
    if (readP) { console.warn('[devolución] no se pudo leer el producto:', readP.message); saltadas.push(String(it.product_id)); continue; }
    // Producto borrado o de stock infinito: no hay nada que devolver.
    if (!p) { saltadas.push(String(it.product_id)); continue; }
    if ((p as any).tracks_stock === false) continue;

    const upd = await db.from('products').update({
      stock_quantity: Number((p as any).stock_quantity ?? 0) + Number(it.quantity),
      updated_at: new Date().toISOString(),
    }).eq('id', it.product_id).eq('tenant_id', tenantId);
    if (upd.error) { console.warn('[devolución] no se pudo devolver stock:', upd.error.message); saltadas.push(String(it.product_id)); }
    else devueltas++;
  }
  if (saltadas.length) console.warn('[devolución] líneas sin devolver:', saltadas.join(', '));

  return { devueltas, saltadas };
}
