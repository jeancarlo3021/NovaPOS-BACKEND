import { db } from '../db/client.js';

/**
 * Motor de recetas: conversión de unidades, costeo y explosión de ingredientes.
 *
 * Vive aparte de `routes/recipes.ts` porque ahora lo necesitan tres lugares que
 * no se conocen entre sí: la pantalla de recetas (costo), la venta (consumo de
 * inventario) y la producción de lotes. Tener el cálculo en un solo lado es lo
 * que evita que el costo que muestra la ficha y el que se descuenta al vender
 * empiecen a diferir.
 */

// ── Unidades ───────────────────────────────────────────────────────────────

export interface MeasureUnit { code: string; name: string; dimension: string; to_base: number }

let unitsCache: { at: number; byCode: Map<string, MeasureUnit> } | null = null;

/** Catálogo de unidades. Cambia casi nunca, así que se cachea 5 minutos. */
export async function loadUnits(): Promise<Map<string, MeasureUnit>> {
  if (unitsCache && Date.now() - unitsCache.at < 300_000) return unitsCache.byCode;
  const byCode = new Map<string, MeasureUnit>();
  try {
    const { data } = await db.from('measure_units').select('code, name, dimension, to_base');
    for (const u of (data ?? []) as any[]) {
      byCode.set(String(u.code), { ...u, to_base: Number(u.to_base) || 1 });
    }
  } catch (e: any) {
    // Sin catálogo (migración 84 sin correr) todo cae al comportamiento viejo.
    console.warn('[recipes] no se pudo leer measure_units:', e?.message);
  }
  unitsCache = { at: Date.now(), byCode };
  return byCode;
}

export interface ConversionResult {
  /** Cantidad expresada en la unidad de destino. */
  quantity: number;
  /** true si hubo una conversión real (ambas unidades conocidas y compatibles). */
  converted: boolean;
  /** Motivo por el que NO se pudo convertir, para poder avisarlo en pantalla. */
  problem?: string;
}

/**
 * Pasa `qty` de la unidad `from` a la unidad `to`.
 *
 * Si falta alguna de las dos unidades devuelve la cantidad TAL CUAL. Esa es la
 * puerta de compatibilidad: las recetas viejas no tienen unidad y su costo tiene
 * que seguir dando exactamente lo mismo que antes, aunque esté mal — cambiarlo
 * en silencio sería peor que dejarlo, porque el negocio ya tomó decisiones de
 * precio con ese número. La pantalla avisa cuáles hay que revisar.
 *
 * Si las unidades existen pero son de dimensiones distintas (gramos → litros),
 * tampoco se inventa nada: no hay forma de saber la densidad.
 */
export function convert(
  qty: number, from: string | null | undefined, to: string | null | undefined,
  units: Map<string, MeasureUnit>,
): ConversionResult {
  const q = Number(qty) || 0;
  if (!from || !to) return { quantity: q, converted: false, problem: 'sin unidad' };
  if (from === to) return { quantity: q, converted: true };

  const uFrom = units.get(from);
  const uTo = units.get(to);
  if (!uFrom || !uTo) return { quantity: q, converted: false, problem: 'unidad desconocida' };
  if (uFrom.dimension !== uTo.dimension) {
    return {
      quantity: q, converted: false,
      problem: `no se puede pasar de ${uFrom.name} a ${uTo.name}`,
    };
  }
  return { quantity: (q * uFrom.to_base) / uTo.to_base, converted: true };
}

// ── Datos del negocio para costear ─────────────────────────────────────────

export interface RecipeContext {
  units: Map<string, MeasureUnit>;
  /** recipe_id → receta */
  recipes: Map<string, any>;
  /** recipe_id → ingredientes */
  ingredients: Map<string, any[]>;
  /** product_id → producto (cost_price, recipe_unit_code, tracks_stock) */
  products: Map<string, any>;
}

export async function loadContext(tenantId: string): Promise<RecipeContext> {
  const [units, recs, ings, prods] = await Promise.all([
    loadUnits(),
    db.from('recipes').select('*').eq('tenant_id', tenantId),
    db.from('recipe_ingredients').select('*').eq('tenant_id', tenantId).order('seq'),
    db.from('products').select('id, name, cost_price, tracks_stock, stock_quantity, recipe_unit_code')
      .eq('tenant_id', tenantId),
  ]);

  const recipes = new Map<string, any>();
  for (const r of ((recs as any).data ?? []) as any[]) recipes.set(r.id, r);

  const ingredients = new Map<string, any[]>();
  for (const i of ((ings as any).data ?? []) as any[]) {
    if (!ingredients.has(i.recipe_id)) ingredients.set(i.recipe_id, []);
    ingredients.get(i.recipe_id)!.push(i);
  }

  const products = new Map<string, any>();
  for (const p of ((prods as any).data ?? []) as any[]) products.set(p.id, p);

  return { units, recipes, ingredients, products };
}

// ── Explosión de una receta a ingredientes de inventario ───────────────────

export interface ExplodedLine {
  product_id: string;
  product_name: string;
  /** Cantidad en la unidad en que está costeado/inventariado el producto. */
  quantity: number;
  unit_code: string | null;
  unit_cost: number;
  total_cost: number;
  /** Aviso cuando la unidad no se pudo convertir (el número es sospechoso). */
  warning?: string;
}

/**
 * Convierte una receta en la lista de productos de inventario que consume,
 * resolviendo subrecetas hacia abajo.
 *
 * `portions` es cuántas porciones del rendimiento se preparan: vender 2 platos
 * de una receta que rinde 4 consume la mitad de los ingredientes.
 *
 * Una subreceta con `output_product_id` NO se explota: se consume como producto
 * de inventario, porque ya se produjo por lote y está en existencias. Esta es la
 * diferencia entre «la salsa se hace al momento» y «la salsa está hecha en la
 * cámara», y cambia por completo qué hay que descontar.
 */
export function explode(
  ctx: RecipeContext, recipeId: string, portions: number,
  stack: Set<string> = new Set(),
): ExplodedLine[] {
  const recipe = ctx.recipes.get(recipeId);
  if (!recipe) return [];
  // Guarda de ciclos: A usa B y B usa A. Devolver vacío corta sin reventar.
  if (stack.has(recipeId)) return [];
  stack.add(recipeId);

  const yieldQty = Number(recipe.yield_qty) || 1;
  const factorRecipe = portions / yieldQty;   // proporción de la receta a preparar
  const out: ExplodedLine[] = [];

  for (const ing of ctx.ingredients.get(recipeId) ?? []) {
    const waste = 1 + (Number(ing.waste_pct) || 0) / 100;   // la merma encarece
    const qty = (Number(ing.quantity) || 0) * factorRecipe * waste;

    if (ing.type === 'subrecipe' && ing.sub_recipe_id) {
      const sub = ctx.recipes.get(ing.sub_recipe_id);
      if (!sub) continue;
      if (sub.output_product_id) {
        // Producida por lotes: se descuenta del inventario como cualquier producto.
        out.push(...lineFor(ctx, sub.output_product_id, qty, ing.unit_code));
      } else {
        // Se prepara al momento: se explota hacia sus propios ingredientes.
        out.push(...explode(ctx, ing.sub_recipe_id, qty, stack));
      }
      continue;
    }

    if (ing.product_id) out.push(...lineFor(ctx, ing.product_id, qty, ing.unit_code));
  }

  stack.delete(recipeId);
  return mergeLines(out);
}

/** Una línea de consumo, ya convertida a la unidad del producto y costeada. */
function lineFor(
  ctx: RecipeContext, productId: string, qty: number, unitCode: string | null,
): ExplodedLine[] {
  const p = ctx.products.get(productId);
  if (!p) return [];
  const target = p.recipe_unit_code ?? null;
  const conv = convert(qty, unitCode, target, ctx.units);
  const unitCost = Number(p.cost_price) || 0;
  return [{
    product_id: productId,
    product_name: p.name ?? '',
    quantity: conv.quantity,
    unit_code: target,
    unit_cost: unitCost,
    total_cost: unitCost * conv.quantity,
    // Solo se avisa cuando había unidades de por medio: una receta vieja sin
    // unidades no debe llenar la pantalla de advertencias todos los días.
    warning: !conv.converted && (unitCode || target)
      ? `${conv.problem} (${unitCode ?? '—'} → ${target ?? '—'})`
      : undefined,
  }];
}

/** Junta el mismo producto usado en varios lugares de la receta. */
function mergeLines(lines: ExplodedLine[]): ExplodedLine[] {
  const by = new Map<string, ExplodedLine>();
  for (const l of lines) {
    const prev = by.get(l.product_id);
    if (!prev) { by.set(l.product_id, { ...l }); continue; }
    prev.quantity += l.quantity;
    prev.total_cost += l.total_cost;
    prev.warning = prev.warning ?? l.warning;
  }
  return [...by.values()];
}

/** Costo total de preparar `portions` porciones de una receta. */
export function recipeCost(ctx: RecipeContext, recipeId: string, portions = 1): number {
  return explode(ctx, recipeId, portions).reduce((s, l) => s + l.total_cost, 0);
}

/** Índice product_id → receta que lo produce (para saber qué explotar al vender). */
export function recipesByProduct(ctx: RecipeContext): Map<string, any> {
  const m = new Map<string, any>();
  for (const r of ctx.recipes.values()) {
    if (r.product_id && r.is_active !== false && !r.is_subrecipe) m.set(r.product_id, r);
  }
  return m;
}
