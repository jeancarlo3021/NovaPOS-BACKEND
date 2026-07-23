import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

// Recetas y subrecetas (fichas técnicas). Ver migrations/65_recipes.sql
const recipes = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const IngSchema = z.object({
  type: z.enum(['product', 'subrecipe']).default('product'),
  product_id: z.string().uuid().optional().nullable(),
  sub_recipe_id: z.string().uuid().optional().nullable(),
  quantity: z.number().nonnegative().default(0),
  unit: z.string().optional().nullable(),
  waste_pct: z.number().min(0).max(100).default(0),
  note: z.string().optional().nullable(),
});
const RecipeSchema = z.object({
  name: z.string().min(1),
  is_subrecipe: z.boolean().default(false),
  product_id: z.string().uuid().optional().nullable(),
  yield_qty: z.number().positive().default(1),
  yield_unit: z.string().optional().nullable(),
  prep_minutes: z.number().int().nonnegative().optional().nullable(),
  instructions: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  // Costeo/precio · cocina · menú/salud · gestión.
  target_margin_pct: z.number().min(0).max(100).optional().nullable(),
  station: z.string().optional().nullable(),
  allergens: z.string().optional().nullable(),
  diet_tags: z.string().optional().nullable(),
  calories: z.number().nonnegative().optional().nullable(),
  protein_g: z.number().nonnegative().optional().nullable(),
  carbs_g: z.number().nonnegative().optional().nullable(),
  fat_g: z.number().nonnegative().optional().nullable(),
  photo_url: z.string().optional().nullable(),
  available_from: z.string().optional().nullable(),
  available_to: z.string().optional().nullable(),
  ingredients: z.array(IngSchema).optional().default([]),
});

// ── Cálculo de costos ────────────────────────────────────────────────────────
// Calcula el costo de cada receta del tenant. Las subrecetas se resuelven de
// forma recursiva (con guarda de ciclos). Devuelve costo total y por unidad de
// rendimiento.
async function computeCosts(tenantId: string): Promise<Map<string, { total: number; perYield: number; yield: number }>> {
  const [{ data: recs }, { data: ings }, { data: prods }] = await Promise.all([
    db.from('recipes').select('id, yield_qty').eq('tenant_id', tenantId),
    db.from('recipe_ingredients').select('recipe_id, type, product_id, sub_recipe_id, quantity, waste_pct').eq('tenant_id', tenantId),
    db.from('products').select('id, cost_price').eq('tenant_id', tenantId),
  ]);
  const yieldOf = new Map<string, number>((recs ?? []).map((r: any) => [r.id, Number(r.yield_qty) || 1]));
  const costPrice = new Map<string, number>((prods ?? []).map((p: any) => [p.id, Number(p.cost_price) || 0]));
  const ingByRecipe = new Map<string, any[]>();
  for (const i of (ings ?? []) as any[]) {
    if (!ingByRecipe.has(i.recipe_id)) ingByRecipe.set(i.recipe_id, []);
    ingByRecipe.get(i.recipe_id)!.push(i);
  }
  const memo = new Map<string, number>();   // costo TOTAL de la receta
  const recipeTotal = (id: string, stack: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return 0;             // ciclo → corta
    stack.add(id);
    let total = 0;
    for (const ing of ingByRecipe.get(id) ?? []) {
      const qty = Number(ing.quantity) || 0;
      const factor = 1 + (Number(ing.waste_pct) || 0) / 100;   // la merma encarece
      if (ing.type === 'subrecipe' && ing.sub_recipe_id) {
        const subTotal = recipeTotal(ing.sub_recipe_id, stack);
        const subYield = yieldOf.get(ing.sub_recipe_id) || 1;
        total += (subTotal / subYield) * qty * factor;
      } else if (ing.product_id) {
        total += (costPrice.get(ing.product_id) ?? 0) * qty * factor;
      }
    }
    stack.delete(id);
    memo.set(id, total);
    return total;
  };
  const out = new Map<string, { total: number; perYield: number; yield: number }>();
  for (const r of (recs ?? []) as any[]) {
    const y = yieldOf.get(r.id) || 1;
    const total = recipeTotal(r.id, new Set());
    out.set(r.id, { total, perYield: total / y, yield: y });
  }
  return out;
}

// GET / — lista de recetas con su costo calculado.
recipes.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const [{ data, error }, costs] = await Promise.all([
      db.from('recipes').select('*').eq('tenant_id', tenantId).eq('is_active', true).order('name'),
      computeCosts(tenantId),
    ]);
    if (error) throw new Error(error.message);
    const rows = (data ?? []).map((r: any) => ({ ...r, ...(costs.get(r.id) ?? { total: 0, perYield: 0, yield: r.yield_qty }) }));
    return ok(c, rows);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id — receta con sus ingredientes + costo.
recipes.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data: r } = await db.from('recipes').select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!r) return fail(c, 'Receta no encontrada', 404);
    const { data: ings } = await db.from('recipe_ingredients')
      .select('*').eq('recipe_id', id).eq('tenant_id', tenantId).order('seq');
    const costs = await computeCosts(tenantId);
    return ok(c, { ...r, ...(costs.get(id) ?? { total: 0, perYield: 0, yield: (r as any).yield_qty }), ingredients: ings ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// Reemplaza los ingredientes de una receta.
async function replaceIngredients(tenantId: string, recipeId: string, list: any[]) {
  await db.from('recipe_ingredients').delete().eq('recipe_id', recipeId).eq('tenant_id', tenantId);
  if (list.length === 0) return;
  const rows = list.map((i, idx) => ({
    tenant_id: tenantId, recipe_id: recipeId, type: i.type ?? 'product',
    product_id: i.type === 'subrecipe' ? null : (i.product_id ?? null),
    sub_recipe_id: i.type === 'subrecipe' ? (i.sub_recipe_id ?? null) : null,
    quantity: Number(i.quantity) || 0, unit: i.unit ?? null,
    waste_pct: Number(i.waste_pct) || 0, note: i.note ?? null, seq: idx,
  }));
  await db.from('recipe_ingredients').insert(rows);
}

// POST / — crear receta.
recipes.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = RecipeSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.errors[0]?.message ?? 'Datos inválidos', 422);
    const { ingredients, ...rec } = parsed.data;
    const { data, error } = await db.from('recipes').insert({ ...rec, tenant_id: tenantId }).select().single();
    if (error) throw new Error(error.message);
    await replaceIngredients(tenantId, (data as any).id, ingredients);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /:id — actualizar receta + ingredientes.
recipes.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const parsed = RecipeSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.errors[0]?.message ?? 'Datos inválidos', 422);
    const { ingredients, ...rec } = parsed.data;
    const { data, error } = await db.from('recipes')
      .update({ ...rec, updated_at: new Date().toISOString() }).eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    await replaceIngredients(tenantId, id, ingredients);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// DELETE /:id — baja lógica.
recipes.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db.from('recipes').update({ is_active: false }).eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default recipes;
