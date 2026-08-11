import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import {
  loadContext, loadUnits, explode, type RecipeContext,
} from '../services/recipeEngine.js';
import { hasFeature } from '../services/planFeatures.js';
import { applyConsumption } from '../services/recipeConsumption.js';

// Recetas y subrecetas (fichas técnicas). Ver migrations/65_recipes.sql
const recipes = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const IngSchema = z.object({
  type: z.enum(['product', 'subrecipe']).default('product'),
  product_id: z.string().uuid().optional().nullable(),
  sub_recipe_id: z.string().uuid().optional().nullable(),
  quantity: z.number().nonnegative().default(0),
  unit: z.string().optional().nullable(),
  /** Unidad del catálogo (g, ml, und…). Sin ella el costeo no convierte. */
  unit_code: z.string().optional().nullable(),
  waste_pct: z.number().min(0).max(100).default(0),
  note: z.string().optional().nullable(),
});
const RecipeSchema = z.object({
  name: z.string().min(1),
  is_subrecipe: z.boolean().default(false),
  product_id: z.string().uuid().optional().nullable(),
  yield_qty: z.number().positive().default(1),
  yield_unit: z.string().optional().nullable(),
  yield_unit_code: z.string().optional().nullable(),
  /** Producto donde se acumula el rendimiento (subrecetas producidas por lote). */
  output_product_id: z.string().uuid().optional().nullable(),
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

  // ── La receta como plato del menú ──────────────────────────────────────
  // En un restaurante el menú SON las recetas. Obligar a crear el producto
  // aparte y acordarse de enlazarlo era trabajo doble y una fuente constante de
  // platos huérfanos: la receta existía pero no se podía vender, o el producto
  // se vendía sin receta y no descontaba nada.
  //
  // Con `sells`, la receta crea (o actualiza) su producto vendible sola.
  /** La receta se vende: crear/mantener su producto en el catálogo. */
  sells: z.boolean().optional(),
  /** Precio de venta del plato. Si no viene, se usa el sugerido por margen. */
  sale_price: z.number().nonnegative().optional().nullable(),
  /**
   * Plato SIN inventario: el producto se crea con stock infinito.
   *
   * Es la salida para el plato que todavía no tiene ficha de ingredientes, o que
   * no se quiere costear (una cerveza que se compra y se revende). Sin esto, la
   * única forma de tener algo en el menú era costearlo primero, y eso hacía que
   * el módulo no se pudiera empezar a usar hasta tenerlo todo cargado.
   */
  no_inventory: z.boolean().optional(),
  category_id: z.string().uuid().optional().nullable(),
  iva_rate: z.number().min(0).max(100).optional().nullable(),
  cabys_code: z.string().optional().nullable(),
});

// ── Cálculo de costos ────────────────────────────────────────────────────────
//
// El cálculo vive en `services/recipeEngine.ts` porque ahora lo comparten tres
// lugares que no se conocen: esta pantalla, la venta (que descuenta ingredientes)
// y la producción de lotes. Si cada uno costeara por su cuenta, el número de la
// ficha y el que se descuenta terminarían distintos.
//
// La conversión de unidades entra sola: un ingrediente sin `unit_code` se
// comporta igual que antes (multiplicación directa), así que las recetas ya
// cargadas no cambian de costo sin que nadie lo haya pedido. Las que sí traen
// unidades quedan bien costeadas y las que no se puedan convertir vienen con un
// `warning` para poder listarlas.
async function computeCosts(
  tenantId: string,
): Promise<{
  costs: Map<string, { total: number; perYield: number; yield: number; warnings: string[] }>;
  ctx: RecipeContext;
}> {
  const ctx = await loadContext(tenantId);
  const costs = new Map<string, { total: number; perYield: number; yield: number; warnings: string[] }>();
  for (const r of ctx.recipes.values()) {
    const y = Number(r.yield_qty) || 1;
    // Se costea el rendimiento COMPLETO (`y` porciones) para que `total` siga
    // significando lo mismo que antes: lo que cuesta hacer la receta entera.
    const lines = explode(ctx, r.id, y);
    const total = lines.reduce((s, l) => s + l.total_cost, 0);
    const warnings = lines.map(l => l.warning).filter(Boolean) as string[];
    costs.set(r.id, { total, perYield: total / y, yield: y, warnings });
  }
  return { costs, ctx };
}

// GET /units — catálogo de unidades de medida (para los selectores).
// Va antes de `/:id` a propósito: si no, Hono lo tomaría como una receta con
// id "units".
recipes.get('/units', async (c) => {
  try {
    const units = await loadUnits();
    return ok(c, [...units.values()]);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /menu — el MENÚ: recetas vendibles, con forma de producto.
//
// En un restaurante lo que se ofrece son las recetas, no el catálogo entero de
// inventario: el mesero no debe ver el tomate ni el aceite, que también son
// productos. Esto devuelve solo las recetas que tienen producto vendible, con
// los datos que el catálogo necesita.
//
// Devuelve la forma de PRODUCTO a propósito. La venta sigue siendo de un
// producto —la factura, el CABYS, el IVA y el consumo de ingredientes cuelgan de
// `product_id`—; lo que cambia es qué se muestra, no qué se vende.
recipes.get('/menu', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data: recs, error } = await db.from('recipes')
      .select('id, name, product_id, station, allergens, diet_tags, photo_url, prep_minutes, is_subrecipe, is_active')
      .eq('tenant_id', tenantId).eq('is_active', true).not('product_id', 'is', null).order('name');
    if (error) return ok(c, []);

    // Las subrecetas no van al menú: una salsa no se le vende a nadie.
    const rows = (recs ?? []).filter((r: any) => !r.is_subrecipe);
    const ids = rows.map((r: any) => r.product_id);
    if (ids.length === 0) return ok(c, []);

    const { data: prods } = await db.from('products')
      .select('id, name, sku, unit_price, iva_rate, cabys_code, category_id, tracks_stock, stock_quantity, image_url')
      .eq('tenant_id', tenantId).in('id', ids);
    const byId = new Map((prods ?? []).map((p: any) => [p.id, p]));

    const menu = rows.map((r: any) => {
      const p = byId.get(r.product_id);
      // Una receta cuyo producto se borró queda fuera: ofrecer algo que no se
      // puede facturar rompe la venta en el peor momento, frente al cliente.
      if (!p) return null;
      return {
        ...p,
        // El nombre y la foto los manda la RECETA: es la ficha que el cocinero
        // mantiene, y así el menú no depende de que alguien edite el producto.
        name: r.name ?? p.name,
        image_url: r.photo_url ?? p.image_url ?? null,
        recipe_id: r.id,
        station: r.station ?? null,
        allergens: r.allergens ?? null,
        diet_tags: r.diet_tags ?? null,
        prep_minutes: r.prep_minutes ?? null,
      };
    }).filter(Boolean);

    return ok(c, menu);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET / — lista de recetas con su costo calculado.
recipes.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const [{ data, error }, { costs }] = await Promise.all([
      db.from('recipes').select('*').eq('tenant_id', tenantId).eq('is_active', true).order('name'),
      computeCosts(tenantId),
    ]);
    if (error) throw new Error(error.message);
    const rows = (data ?? []).map((r: any) => ({
      ...r,
      ...(costs.get(r.id) ?? { total: 0, perYield: 0, yield: r.yield_qty, warnings: [] }),
    }));
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
    const { costs, ctx } = await computeCosts(tenantId);
    // El desglose por ingrediente ya convertido: es lo que deja ver DÓNDE está
    // el costo y cuál línea tiene la unidad mal puesta.
    const breakdown = explode(ctx, id, Number((r as any).yield_qty) || 1);
    return ok(c, {
      ...r,
      ...(costs.get(id) ?? { total: 0, perYield: 0, yield: (r as any).yield_qty, warnings: [] }),
      ingredients: ings ?? [],
      breakdown,
    });
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
    unit_code: i.unit_code || null,
    waste_pct: Number(i.waste_pct) || 0, note: i.note ?? null, seq: idx,
  }));
  let ins = await db.from('recipe_ingredients').insert(rows);
  // Si la migración 84 no corrió, la columna no existe todavía: se reintenta sin
  // ella para no dejar al negocio sin poder guardar una receta.
  if (ins.error && /unit_code/.test(ins.error.message ?? '')) {
    ins = await db.from('recipe_ingredients').insert(rows.map(({ unit_code: _u, ...r }) => r));
  }
  if (ins.error) throw new Error(ins.error.message);
}

/**
 * Crea o actualiza el PRODUCTO VENDIBLE de una receta y devuelve su id.
 *
 * El producto sigue siendo lo que se vende —la factura, el CABYS, el IVA, el
 * stock y el consumo de ingredientes cuelgan de `product_id`—, pero deja de ser
 * algo que el cocinero tenga que crear a mano. La receta manda: su nombre, su
 * precio y su foto bajan al producto cada vez que se guarda.
 *
 * `sale_price` gana sobre el margen objetivo. Si no hay ninguno de los dos, el
 * plato se crea en 0 y queda visible como pendiente de precio, que es mejor que
 * inventar uno.
 */
async function syncSellableProduct(
  tenantId: string, recipeId: string, rec: any, existingProductId: string | null,
  costPerYield: number,
): Promise<string | null> {
  // ── ¿El plan permite recetas CON inventario? ───────────────────────────
  // Hay negocios que solo quieren la carta y el cobro: una ventanita de comidas
  // no lleva existencias de nada. Para esos, el plato se crea siempre infinito.
  //
  // Se decide en el SERVIDOR y no escondiendo la casilla: si el tope viviera
  // solo en la pantalla, un cliente viejo o una llamada directa a la API
  // seguirían creando productos con stock que el negocio no puede administrar.
  const canTrackStock = await hasFeature(tenantId, 'recipe_inventory');
  const noInventory = !canTrackStock || !!rec.no_inventory;
  const price = (() => {
    const explicit = Number(rec.sale_price);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const margin = Number(rec.target_margin_pct);
    if (margin > 0 && margin < 100 && costPerYield > 0) {
      return Math.round(costPerYield / (1 - margin / 100));
    }
    return 0;
  })();

  const patch: any = {
    name: String(rec.name).trim(),
    unit_price: price,
    cost_price: costPerYield,
    // Sin inventario = stock infinito. El plato se puede vender aunque no tenga
    // ficha de ingredientes todavía.
    tracks_stock: !noInventory,
    updated_at: new Date().toISOString(),
  };
  if (rec.category_id !== undefined) patch.category_id = rec.category_id || null;
  if (rec.iva_rate != null) patch.iva_rate = rec.iva_rate;
  if (rec.cabys_code) patch.cabys_code = String(rec.cabys_code);
  if (rec.photo_url) patch.image_url = rec.photo_url;

  if (existingProductId) {
    const { error } = await db.from('products')
      .update(patch).eq('id', existingProductId).eq('tenant_id', tenantId);
    // Una columna que no exista (image_url en instalaciones viejas) no debe
    // impedir guardar la receta: se reintenta con lo esencial.
    if (error) {
      const { name, unit_price, tracks_stock, updated_at } = patch;
      await db.from('products').update({ name, unit_price, tracks_stock, updated_at })
        .eq('id', existingProductId).eq('tenant_id', tenantId);
    }
    return existingProductId;
  }

  // SKU derivado de la receta: legible y estable, para poder buscarlo en caja.
  const sku = `REC-${recipeId.slice(0, 8).toUpperCase()}`;
  let ins = await db.from('products')
    .insert({ ...patch, tenant_id: tenantId, sku, stock_quantity: 0 })
    .select('id').single();
  if (ins.error) {
    const { name, unit_price, tracks_stock } = patch;
    ins = await db.from('products')
      .insert({ tenant_id: tenantId, sku, name, unit_price, tracks_stock, stock_quantity: 0 })
      .select('id').single();
  }
  if (ins.error) {
    console.warn('[recipes] no se pudo crear el producto vendible:', ins.error.message);
    return null;
  }
  return (ins.data as any).id;
}

// POST / — crear receta.
recipes.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = RecipeSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.errors[0]?.message ?? 'Datos inválidos', 422);
    // Los campos del PLATO no son columnas de `recipes`: se usan para armar el
    // producto vendible y no deben viajar al insert.
    const { ingredients, sells, sale_price, no_inventory, category_id, iva_rate, cabys_code, ...rec } = parsed.data;
    const { data, error } = await db.from('recipes').insert({ ...rec, tenant_id: tenantId }).select().single();
    if (error) throw new Error(error.message);
    const id = (data as any).id;
    await replaceIngredients(tenantId, id, ingredients);

    if (sells) {
      const { costs } = await computeCosts(tenantId);
      const productId = await syncSellableProduct(
        tenantId, id,
        { ...rec, sale_price, no_inventory, category_id, iva_rate, cabys_code },
        rec.product_id ?? null,
        costs.get(id)?.perYield ?? 0,
      );
      if (productId && productId !== rec.product_id) {
        await db.from('recipes').update({ product_id: productId }).eq('id', id).eq('tenant_id', tenantId);
        (data as any).product_id = productId;
      }
    }
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
    const { ingredients, sells, sale_price, no_inventory, category_id, iva_rate, cabys_code, ...rec } = parsed.data;
    const { data, error } = await db.from('recipes')
      .update({ ...rec, updated_at: new Date().toISOString() }).eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    await replaceIngredients(tenantId, id, ingredients);

    if (sells) {
      // El costo se recalcula DESPUÉS de guardar los ingredientes: si no, el
      // precio sugerido saldría con la receta anterior.
      const { costs } = await computeCosts(tenantId);
      const productId = await syncSellableProduct(
        tenantId, id,
        { ...rec, sale_price, no_inventory, category_id, iva_rate, cabys_code },
        (data as any).product_id ?? null,
        costs.get(id)?.perYield ?? 0,
      );
      if (productId && productId !== (data as any).product_id) {
        await db.from('recipes').update({ product_id: productId }).eq('id', id).eq('tenant_id', tenantId);
        (data as any).product_id = productId;
      }
    }
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

// ══════════════════════════════════════════════════════════════════════════
// PRODUCCIÓN DE SUBRECETAS
// ══════════════════════════════════════════════════════════════════════════
//
// Producir un lote consume los ingredientes de la receta y deja el rendimiento
// disponible como producto de inventario. Es lo que le da existencia real a una
// preparación base: sin esto, o se descontaban los ingredientes al vender cada
// plato (y la salsa nunca existía), o había que llevarla a mano.

// GET /productions — historial de lotes producidos.
recipes.get('/productions/list', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('recipe_productions')
      .select('*').eq('tenant_id', tenantId)
      .order('produced_at', { ascending: false }).limit(200);
    if (error) return ok(c, { rows: [], available: false, message: error.message });
    // Nombres de receta y producto, en una consulta aparte (tablas chicas).
    const rows = (data ?? []) as any[];
    const rIds = [...new Set(rows.map(r => r.recipe_id).filter(Boolean))];
    if (rIds.length) {
      const { data: recs } = await db.from('recipes').select('id, name').in('id', rIds);
      const byId = new Map((recs ?? []).map((r: any) => [r.id, r.name]));
      for (const r of rows) r.recipe_name = byId.get(r.recipe_id) ?? '';
    }
    return ok(c, { rows, available: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /productions — registra un lote: descuenta ingredientes, suma rendimiento.
// body: { recipe_id, batches, notes? }
recipes.post('/productions', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!(await hasFeature(tenantId, 'recipe_production'))) {
      return fail(c, 'La producción de subrecetas no está incluida en tu plan.', 403);
    }
    const b = await c.req.json().catch(() => ({} as any));
    const recipeId = String(b?.recipe_id ?? '');
    const batches = Number(b?.batches);
    if (!recipeId) return fail(c, 'Falta la receta', 422);
    if (!Number.isFinite(batches) || batches <= 0) return fail(c, 'Cantidad de lotes inválida', 422);

    const ctx = await loadContext(tenantId);
    const recipe = ctx.recipes.get(recipeId);
    if (!recipe) return fail(c, 'Receta no encontrada', 404);

    const outProductId = recipe.output_product_id ?? recipe.product_id ?? null;
    if (!outProductId) {
      return fail(c,
        'Esta receta no tiene un producto donde acumular lo producido. '
        + 'Asignale uno en «Producto resultante» antes de producir.', 422);
    }

    const yieldQty = (Number(recipe.yield_qty) || 1) * batches;
    // Se explota el rendimiento COMPLETO del lote: producir 3 veces una receta
    // que rinde 4 L consume los ingredientes de 12 L.
    const lines = explode(ctx, recipeId, yieldQty);
    if (lines.length === 0) return fail(c, 'La receta no tiene ingredientes que consumir.', 422);

    // Faltantes: se avisa pero NO se bloquea. En cocina el inventario teórico casi
    // nunca cuadra al gramo, y trabar la producción por eso deja al negocio sin
    // poder registrar lo que ya cocinó.
    const shortages: string[] = [];
    for (const l of lines) {
      const p = ctx.products.get(l.product_id);
      if (p && p.tracks_stock !== false && Number(p.stock_quantity ?? 0) < l.quantity) {
        shortages.push(`${l.product_name}: hay ${Number(p.stock_quantity ?? 0)}, se necesitan ${l.quantity.toFixed(2)}`);
      }
    }

    const totalCost = lines.reduce((s, l) => s + l.total_cost, 0);
    const { data: prod, error: pErr } = await db.from('recipe_productions').insert({
      tenant_id: tenantId, recipe_id: recipeId, output_product_id: outProductId,
      batches, yield_qty: yieldQty, yield_unit_code: recipe.yield_unit_code ?? null,
      total_cost: totalCost, unit_cost: yieldQty > 0 ? totalCost / yieldQty : 0,
      notes: b?.notes ?? null, produced_by: c.get('userId') ?? null,
    }).select('id').single();
    if (pErr) throw new Error(pErr.message);
    const productionId = (prod as any).id;

    // Descontar ingredientes y dejar la bitácora de consumo.
    await applyConsumption(tenantId, lines, { production_id: productionId, recipe_id: recipeId });

    // Sumar el rendimiento al producto resultante, con su costo real del lote.
    const outP = ctx.products.get(outProductId);
    if (outP && outP.tracks_stock !== false) {
      await db.from('products').update({
        stock_quantity: Number(outP.stock_quantity ?? 0) + yieldQty,
        cost_price: yieldQty > 0 ? totalCost / yieldQty : Number(outP.cost_price ?? 0),
        updated_at: new Date().toISOString(),
      }).eq('id', outProductId).eq('tenant_id', tenantId);
    }

    return ok(c, {
      ok: true, production_id: productionId, yield_qty: yieldQty,
      total_cost: totalCost, unit_cost: yieldQty > 0 ? totalCost / yieldQty : 0,
      consumed: lines, shortages,
    }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// REPORTES
// ══════════════════════════════════════════════════════════════════════════

// GET /reports/menu-engineering?from=&to=
//
// Cruza lo que ya existía por separado: el COSTO de la receta y las VENTAS del
// producto. Clasifica cada plato en el cuadrante clásico:
//
//   ESTRELLA  popular y rentable  → no tocarlo, destacarlo en la carta
//   VACA      popular, poco margen→ subir precio o bajar costo, con cuidado
//   ENIGMA    rentable, poco vendido → empujarlo: es donde está la plata
//   PERRO     ni popular ni rentable → sacarlo de la carta
//
// El corte es la MEDIA del período, no un número fijo: un plato es "popular"
// respecto de los demás platos del mismo local, no de una tabla universal.
recipes.get('/reports/menu-engineering', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!(await hasFeature(tenantId, 'recipe_menu_engineering'))) {
      return fail(c, 'El análisis de menú no está incluido en tu plan.', 403);
    }
    const from = c.req.query('from');
    const to = c.req.query('to');

    let q = db.from('invoice_items')
      .select('product_id, product_name, quantity, subtotal, unit_cost, total_cost, invoices!inner(tenant_id, status, issued_at)')
      .eq('invoices.tenant_id', tenantId).neq('invoices.status', 'cancelled').limit(20000);
    if (from) q = q.gte('invoices.issued_at', from);
    if (to) q = q.lte('invoices.issued_at', to);
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    // Costo actual de la receta, como respaldo para las ventas anteriores a que
    // se empezara a congelar el costo.
    const { costs, ctx } = await computeCosts(tenantId);
    const recipeOf = new Map<string, any>();
    for (const r of ctx.recipes.values()) if (r.product_id) recipeOf.set(r.product_id, r);

    type Row = {
      product_id: string; name: string; qty: number;
      revenue: number; cost: number; margin: number;
      cost_pct: number; estimated: boolean; classification?: string;
    };
    const by = new Map<string, Row>();
    for (const it of (data ?? []) as any[]) {
      if (!it.product_id) continue;
      const key = String(it.product_id);
      if (!by.has(key)) {
        by.set(key, {
          product_id: key, name: it.product_name ?? '', qty: 0,
          revenue: 0, cost: 0, margin: 0, cost_pct: 0, estimated: false,
        });
      }
      const row = by.get(key)!;
      const qty = Number(it.quantity) || 0;
      row.qty += qty;
      row.revenue += Number(it.subtotal) || 0;

      // Costo CONGELADO si existe; si no, el de la receta de hoy (y se marca
      // `estimated` para que nadie lo lea como dato histórico exacto).
      if (it.total_cost != null) {
        row.cost += Number(it.total_cost) || 0;
      } else {
        const rec = recipeOf.get(key);
        const per = rec ? (costs.get(rec.id)?.perYield ?? 0) : 0;
        row.cost += per * qty;
        if (per > 0) row.estimated = true;
      }
    }

    const rows = [...by.values()];
    for (const r of rows) {
      r.margin = r.revenue - r.cost;
      r.cost_pct = r.revenue > 0 ? (r.cost / r.revenue) * 100 : 0;
    }

    // Cortes: media de unidades vendidas y media del margen por unidad.
    const totalQty = rows.reduce((s, r) => s + r.qty, 0);
    const avgQty = rows.length ? totalQty / rows.length : 0;
    const marginPerUnit = (r: Row) => (r.qty > 0 ? r.margin / r.qty : 0);
    const avgMargin = rows.length
      ? rows.reduce((s, r) => s + marginPerUnit(r), 0) / rows.length : 0;

    for (const r of rows) {
      const popular = r.qty >= avgQty;
      const profitable = marginPerUnit(r) >= avgMargin;
      r.classification = popular && profitable ? 'estrella'
        : popular ? 'vaca'
        : profitable ? 'enigma'
        : 'perro';
    }
    rows.sort((a, b) => b.revenue - a.revenue);

    return ok(c, {
      rows,
      totals: {
        revenue: rows.reduce((s, r) => s + r.revenue, 0),
        cost: rows.reduce((s, r) => s + r.cost, 0),
        margin: rows.reduce((s, r) => s + r.margin, 0),
      },
      cuts: { avg_qty: avgQty, avg_margin_per_unit: avgMargin },
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /reports/food-cost?from=&to=
//
// Consumo TEÓRICO (lo que las recetas dicen que debió salir) contra el consumo
// REAL. La diferencia es merma, robo o mala porción, y es la métrica que
// justifica todo el módulo.
//
// ── Cómo se arma el "real", sin rehacer la aritmética ─────────────────────
// Todo movimiento de inventario ya pasa por algún lado: las ventas y el consumo
// por recetas bajan `products.stock_quantity`, las compras y los ajustes quedan
// en `stock_adjustments`. Cuando se hace una TOMA FÍSICA, el sistema guarda un
// ajuste tipo 'count' con `quantity` = contado − lo que el sistema creía.
//
// Esa diferencia YA ES la varianza: todo lo demás (ventas, compras, recetas,
// mermas) ya estaba descontado del número del sistema. Reconstruirla sumando y
// restando movimientos daría el mismo resultado con diez veces más formas de
// equivocarse. Así que:
//
//   consumo real = consumo teórico + merma registrada + varianza del conteo
//
// La varianza es lo NO EXPLICADO. Es la cifra que importa: la merma registrada
// ya tiene dueño y motivo; la varianza es la que hay que ir a buscar.
recipes.get('/reports/food-cost', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!(await hasFeature(tenantId, 'recipe_consumption'))) {
      return fail(c, 'El consumo por recetas no está incluido en tu plan.', 403);
    }
    const from = c.req.query('from');
    const to = c.req.query('to');

    interface Row {
      product_id: string; name: string; unit_cost: number;
      theo_qty: number; theo_cost: number;      // recetas
      waste_qty: number; waste_cost: number;    // merma registrada (con motivo)
      var_qty: number; var_cost: number;        // varianza del conteo (sin explicar)
      counted_at: string | null;
    }
    const by = new Map<string, Row>();
    const row = (id: string): Row => {
      if (!by.has(id)) {
        by.set(id, {
          product_id: id, name: '', unit_cost: 0,
          theo_qty: 0, theo_cost: 0, waste_qty: 0, waste_cost: 0,
          var_qty: 0, var_cost: 0, counted_at: null,
        });
      }
      return by.get(id)!;
    };

    // 1) Consumo teórico: lo que las recetas dicen que salió.
    let q = db.from('recipe_consumptions')
      .select('product_id, quantity, total_cost, created_at')
      .eq('tenant_id', tenantId).is('reverted_at', null).limit(50000);
    if (from) q = q.gte('created_at', from);
    if (to) q = q.lte('created_at', to);
    const { data: cons, error } = await q;
    if (error) return ok(c, { rows: [], available: false, message: error.message });
    for (const r of (cons ?? []) as any[]) {
      const x = row(String(r.product_id));
      x.theo_qty += Number(r.quantity) || 0;
      x.theo_cost += Number(r.total_cost) || 0;
    }

    // 2) Mermas registradas y tomas físicas, del mismo período.
    //    'count' trae la varianza ya calculada; damage/expired/theft son la
    //    merma que alguien se tomó el trabajo de justificar.
    let aq = db.from('stock_adjustments')
      .select('product_id, type, quantity, created_at')
      .eq('tenant_id', tenantId)
      .in('type', ['damage', 'expired', 'theft', 'count']).limit(50000);
    if (from) aq = aq.gte('created_at', from);
    if (to) aq = aq.lte('created_at', to);
    const { data: adj } = await aq;
    for (const a of (adj ?? []) as any[]) {
      const x = row(String(a.product_id));
      const qty = Number(a.quantity) || 0;
      if (a.type === 'count') {
        // Negativa = faltó producto (lo normal). Positiva = sobró.
        x.var_qty += qty;
        if (!x.counted_at || a.created_at > x.counted_at) x.counted_at = a.created_at;
      } else {
        x.waste_qty += Math.abs(qty);
      }
    }

    // 3) Costo unitario para valorar merma y varianza.
    const ids = [...by.keys()];
    if (ids.length) {
      const { data: prods } = await db.from('products')
        .select('id, name, cost_price').eq('tenant_id', tenantId).in('id', ids);
      for (const p of (prods ?? []) as any[]) {
        const x = by.get(String(p.id));
        if (!x) continue;
        x.name = p.name ?? '';
        x.unit_cost = Number(p.cost_price) || 0;
        x.waste_cost = x.waste_qty * x.unit_cost;
        // La varianza se valora en positivo cuando FALTA producto: es plata que
        // se perdió. Un sobrante se muestra en negativo.
        x.var_cost = -x.var_qty * x.unit_cost;
      }
    }

    const rows = [...by.values()]
      // Sin movimiento no hay nada que mirar: llenar el reporte de ceros esconde
      // las líneas que sí importan.
      .filter(r => r.theo_qty !== 0 || r.waste_qty !== 0 || r.var_qty !== 0)
      .sort((a, b) => (b.var_cost + b.waste_cost) - (a.var_cost + a.waste_cost));

    const theo = rows.reduce((s, r) => s + r.theo_cost, 0);
    const waste = rows.reduce((s, r) => s + r.waste_cost, 0);
    const variance = rows.reduce((s, r) => s + r.var_cost, 0);

    return ok(c, {
      rows, available: true,
      totals: {
        theoretical: theo,
        waste,
        variance,
        real: theo + waste + variance,
        // Cuánto del costo real se va en cosas que no son la receta. Es el número
        // que un dueño mira primero.
        leak_pct: theo > 0 ? ((waste + variance) / theo) * 100 : 0,
      },
      counted: rows.filter(r => r.counted_at).length,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default recipes;
