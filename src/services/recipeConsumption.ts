import { db } from '../db/client.js';
import { hasFeature } from './planFeatures.js';
import {
  loadContext, explode, recipesByProduct, convert,
  type ExplodedLine, type RecipeContext,
} from './recipeEngine.js';

/**
 * Consumo de ingredientes: descuenta el inventario y deja la bitácora.
 *
 * Lo usan la VENTA (vender un plato consume su receta) y la PRODUCCIÓN (hacer un
 * lote de salsa consume los suyos). Es el mismo movimiento visto desde dos lados,
 * y tenerlo en una sola función evita que uno de los dos se olvide de registrar.
 */

export interface ConsumptionOrigin {
  invoice_id?: string;
  production_id?: string;
  recipe_id?: string;
}

/**
 * Aplica el consumo: baja el stock de cada ingrediente y guarda el detalle.
 *
 * La bitácora NO es opcional: una receta que se edita mañana vuelve
 * irreconstruible lo que se consumió hoy. Sin ella, comparar consumo teórico
 * contra real —que es de lo que se trata todo esto— sería imposible.
 *
 * El stock puede quedar NEGATIVO a propósito. En cocina el inventario teórico
 * casi nunca cuadra al gramo; forzar un piso en cero escondería justo la
 * diferencia que se quiere medir.
 */
export async function applyConsumption(
  tenantId: string, lines: ExplodedLine[], origin: ConsumptionOrigin,
): Promise<void> {
  if (lines.length === 0) return;

  const rows = lines.map(l => ({
    tenant_id: tenantId,
    invoice_id: origin.invoice_id ?? null,
    production_id: origin.production_id ?? null,
    recipe_id: origin.recipe_id ?? null,
    product_id: l.product_id,
    quantity: l.quantity,
    unit_code: l.unit_code,
    unit_cost: l.unit_cost,
    total_cost: l.total_cost,
  }));
  const { error } = await db.from('recipe_consumptions').insert(rows);
  if (error) {
    // Si la bitácora no se puede escribir, NO se descuenta stock: dejar el
    // inventario movido sin registro de por qué es peor que no moverlo.
    throw new Error(`No se pudo registrar el consumo de ingredientes: ${error.message}`);
  }

  for (const l of lines) {
    const { data: p } = await db.from('products')
      .select('stock_quantity, tracks_stock').eq('id', l.product_id).eq('tenant_id', tenantId).maybeSingle();
    if (!p || (p as any).tracks_stock === false) continue;   // infinitos no se tocan
    await db.from('products').update({
      stock_quantity: Number((p as any).stock_quantity ?? 0) - l.quantity,
      updated_at: new Date().toISOString(),
    }).eq('id', l.product_id).eq('tenant_id', tenantId);
  }
}

/**
 * Consumo de UNA venta: explota las recetas de los productos vendidos.
 *
 * Devuelve las líneas consumidas y el costo unitario POR PRODUCTO (para poder
 * congelarlo). Se indexa por producto y no por ítem porque los ítems todavía no
 * tienen id: se acaban de insertar en la misma transacción lógica.
 *
 * Si el negocio no tiene la función, no hace nada y devuelve vacío — la venta
 * sigue funcionando exactamente igual que antes.
 *
 * Los productos SIN receta no se tocan acá: su stock ya lo descontó la venta
 * como siempre. Descontarlo dos veces sería el error obvio de esta integración.
 */
export async function consumeForInvoice(
  tenantId: string,
  invoiceId: string,
  items: Array<{
    product_id?: string | null; quantity: number;
    modifiers?: Array<{ group?: string; name?: string }> | null;
  }>,
): Promise<{ lines: ExplodedLine[]; costByProduct: Map<string, number>; recipeProductIds: Set<string> }> {
  const empty = {
    lines: [] as ExplodedLine[],
    costByProduct: new Map<string, number>(),
    recipeProductIds: new Set<string>(),
  };
  if (!(await hasFeature(tenantId, 'recipe_consumption'))) return empty;

  let ctx: RecipeContext;
  try { ctx = await loadContext(tenantId); }
  catch (e: any) { console.warn('[recipes] contexto no disponible:', e?.message); return empty; }

  const byProduct = recipesByProduct(ctx);
  const modIngredients = await loadModifierIngredients(tenantId, items);
  if (byProduct.size === 0 && modIngredients.size === 0) return empty;

  const all: ExplodedLine[] = [];
  const costByProduct = new Map<string, number>();
  const recipeProductIds = new Set<string>();

  for (const it of items) {
    if (!it.product_id) continue;
    const qty = Number(it.quantity) || 0;
    if (qty <= 0) continue;

    const lines: ExplodedLine[] = [];
    const recipe = byProduct.get(it.product_id);
    if (recipe) {
      lines.push(...explode(ctx, recipe.id, qty));
      recipeProductIds.add(it.product_id);
    }

    // Extras elegidos: cada uno puede consumir lo suyo. Se resuelven por nombre
    // de grupo + nombre de opción porque es lo que viaja con la línea del
    // carrito; el id de la opción nunca llegó hasta acá.
    for (const sel of it.modifiers ?? []) {
      const ing = modIngredients.get(modKey(it.product_id, sel?.group, sel?.name));
      if (!ing) continue;
      lines.push(...explodeIngredient(ctx, ing, qty));
    }

    if (lines.length === 0) continue;
    all.push(...lines);
    // Costo POR UNIDAD vendida: el mismo producto puede venir en varias líneas
    // de la misma factura y el costo unitario tiene que ser uno solo.
    const cost = lines.reduce((s, l) => s + l.total_cost, 0);
    costByProduct.set(it.product_id, cost / qty);
  }

  // Se juntan las líneas de todas las recetas: si dos platos llevan arroz, es un
  // solo descuento y un solo renglón de bitácora.
  const merged = new Map<string, ExplodedLine>();
  for (const l of all) {
    const prev = merged.get(l.product_id);
    if (!prev) { merged.set(l.product_id, { ...l }); continue; }
    prev.quantity += l.quantity;
    prev.total_cost += l.total_cost;
  }

  return { lines: [...merged.values()], costByProduct, recipeProductIds };
}

/** Clave de una opción elegida: producto + grupo + nombre, todo normalizado. */
function modKey(productId: string, group?: string | null, name?: string | null): string {
  const n = (s: any) => String(s ?? '').trim().toLowerCase();
  return `${productId}::${n(group)}::${n(name)}`;
}

/**
 * Ingredientes de los extras que aparecen en esta venta.
 *
 * Se indexan por nombre porque es lo único que viaja con la línea del carrito.
 * Renombrar un extra después de vender rompe el vínculo hacia atrás, pero no
 * hacia adelante: es el precio de no haber puesto el id en el carrito, y
 * cambiarlo ahora obligaría a migrar las ventas ya guardadas.
 */
async function loadModifierIngredients(
  tenantId: string,
  items: Array<{ product_id?: string | null; modifiers?: Array<{ group?: string; name?: string }> | null }>,
): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const productIds = [...new Set(
    items.filter(i => i.product_id && (i.modifiers?.length ?? 0) > 0).map(i => i.product_id))] as string[];
  if (productIds.length === 0) return out;

  try {
    const { data: groups } = await db.from('product_modifier_groups')
      .select('id, product_id, name').eq('tenant_id', tenantId).in('product_id', productIds);
    if (!groups?.length) return out;

    const { data: opts } = await db.from('product_modifiers')
      .select('id, group_id, name').in('group_id', (groups as any[]).map(g => g.id));
    if (!opts?.length) return out;

    const { data: ings } = await db.from('modifier_ingredients')
      .select('*').eq('tenant_id', tenantId).in('modifier_id', (opts as any[]).map(o => o.id));
    if (!ings?.length) return out;

    const groupById = new Map((groups as any[]).map(g => [g.id, g]));
    const ingByModifier = new Map((ings as any[]).map(i => [i.modifier_id, i]));
    for (const o of opts as any[]) {
      const ing = ingByModifier.get(o.id);
      if (!ing) continue;
      const g = groupById.get(o.group_id);
      if (!g) continue;
      out.set(modKey(g.product_id, g.name, o.name), ing);
    }
  } catch (e: any) {
    // Migración 84 sin correr: los extras simplemente no consumen nada.
    console.warn('[recipes] ingredientes de extras no disponibles:', e?.message);
  }
  return out;
}

/** Un ingrediente suelto (de un extra) explotado a líneas de inventario. */
function explodeIngredient(ctx: RecipeContext, ing: any, times: number): ExplodedLine[] {
  const waste = 1 + (Number(ing.waste_pct) || 0) / 100;
  const qty = (Number(ing.quantity) || 0) * times * waste;
  if (qty <= 0) return [];

  if (ing.type === 'subrecipe' && ing.sub_recipe_id) {
    const sub = ctx.recipes.get(ing.sub_recipe_id);
    if (!sub) return [];
    // Producida por lote → sale del inventario; si no, se explota hacia abajo.
    return sub.output_product_id
      ? explodeProduct(ctx, sub.output_product_id, qty, ing.unit_code)
      : explode(ctx, ing.sub_recipe_id, qty);
  }
  return ing.product_id ? explodeProduct(ctx, ing.product_id, qty, ing.unit_code) : [];
}

/** Línea de inventario para un producto, convertida y costeada. */
function explodeProduct(
  ctx: RecipeContext, productId: string, qty: number, unitCode: string | null,
): ExplodedLine[] {
  const p = ctx.products.get(productId);
  if (!p) return [];
  const target = p.recipe_unit_code ?? null;
  const conv = convert(qty, unitCode, target, ctx.units);
  const unitCost = Number(p.cost_price) || 0;
  return [{
    product_id: productId, product_name: p.name ?? '',
    quantity: conv.quantity, unit_code: target,
    unit_cost: unitCost, total_cost: unitCost * conv.quantity,
    warning: !conv.converted && (unitCode || target) ? conv.problem : undefined,
  }];
}

/**
 * Congela el costo de cada línea de la factura.
 *
 * Prioridad: el costo de la RECETA si el producto tiene una (es el costo real de
 * producir ese plato), y si no, el `cost_price` del producto. Se escribe después
 * de insertar los ítems, buscando por producto: los ítems no tenían id cuando se
 * calculó el costo.
 *
 * Un producto ad-hoc (sin `product_id`) queda sin costo a propósito: no hay de
 * dónde sacarlo, y poner 0 lo haría parecer margen puro en los reportes.
 */
export async function snapshotItemCosts(
  tenantId: string,
  invoiceId: string,
  items: Array<{ product_id?: string | null }>,
  costByProduct: Map<string, number>,
): Promise<void> {
  if (!(await hasFeature(tenantId, 'recipe_cost_history'))) return;

  const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))] as string[];
  if (productIds.length === 0) return;

  // Costo de catálogo para los que no tienen receta.
  const { data: prods } = await db.from('products')
    .select('id, cost_price').eq('tenant_id', tenantId).in('id', productIds);
  const catalogCost = new Map<string, number>(
    (prods ?? []).map((p: any) => [p.id, Number(p.cost_price) || 0]));

  const { data: rows } = await db.from('invoice_items')
    .select('id, product_id, quantity').eq('invoice_id', invoiceId);

  for (const r of (rows ?? []) as any[]) {
    if (!r.product_id) continue;
    const unit = costByProduct.get(r.product_id) ?? catalogCost.get(r.product_id);
    if (unit == null) continue;
    const qty = Number(r.quantity) || 0;
    const { error } = await db.from('invoice_items')
      .update({ unit_cost: unit, total_cost: unit * qty }).eq('id', r.id);
    // Migración 84 sin correr: no hay columna donde guardarlo. No es un error
    // del usuario y no debe ensuciar el log en cada venta.
    if (error && /unit_cost|total_cost/.test(error.message ?? '')) return;
  }
}

/**
 * Devuelve al inventario lo que consumió una venta anulada.
 *
 * Se marca `reverted_at` en vez de borrar: la bitácora tiene que poder mostrar
 * que hubo un consumo y que se revirtió. Borrarlo dejaría un hueco que después
 * nadie sabe explicar.
 */
export async function revertConsumption(tenantId: string, invoiceId: string): Promise<void> {
  const { data, error } = await db.from('recipe_consumptions')
    .select('id, product_id, quantity')
    .eq('tenant_id', tenantId).eq('invoice_id', invoiceId).is('reverted_at', null);
  if (error || !data?.length) return;

  for (const r of data as any[]) {
    const { data: p } = await db.from('products')
      .select('stock_quantity, tracks_stock').eq('id', r.product_id).eq('tenant_id', tenantId).maybeSingle();
    if (!p || (p as any).tracks_stock === false) continue;
    await db.from('products').update({
      stock_quantity: Number((p as any).stock_quantity ?? 0) + Number(r.quantity),
      updated_at: new Date().toISOString(),
    }).eq('id', r.product_id).eq('tenant_id', tenantId);
  }

  await db.from('recipe_consumptions')
    .update({ reverted_at: new Date().toISOString() })
    .eq('tenant_id', tenantId).eq('invoice_id', invoiceId).is('reverted_at', null);
}
