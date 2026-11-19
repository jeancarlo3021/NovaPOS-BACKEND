import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { requirePermission } from '../middleware/permissions.js';
import { insertarAjustes } from '../utils/stockAjustes.js';

const stockAdjustments = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const AdjustmentSchema = z.object({
  product_id: z.string().uuid(),
  type: z.enum(['increase', 'decrease', 'set', 'damage', 'expired', 'theft', 'return', 'count']),
  quantity: z.number(),                // diferencia a aplicar (puede ser negativa para decrease)
  reason: z.string().min(1),
  notes: z.string().optional().nullable(),
  user_email: z.string().optional().nullable(),
});

/**
 * GET / — los movimientos de inventario, con filtros.
 *
 * ── `search`: buscar por producto ────────────────────────────────────────
 * «¿Qué le pasó al arroz este mes?» es LA pregunta de este reporte, y no se
 * podía hacer: había que recorrer la lista a ojo. El nombre vive en la tabla
 * de productos, así que se resuelve en dos pasos —los ids que calzan, y los
 * movimientos de esos ids— en vez de filtrar sobre la tabla incrustada: es más
 * fácil de leer, no depende de la sintaxis de filtros anidados, y permite
 * decir «ningún producto con ese nombre» en vez de devolver una lista vacía
 * que se lee como «no hubo movimientos».
 *
 * ── `limit`: el tope, dicho ──────────────────────────────────────────────
 * Esta consulta no tenía límite, y sin límite Supabase devuelve MIL filas y se
 * calla. En un mes movido el reporte mostraba los últimos mil movimientos como
 * si fueran todos, y los conteos de arriba salían mal sin que nada lo
 * advirtiera. Ahora el tope es explícito y el cliente lo puede subir.
 */
stockAdjustments.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const productId = c.req.query('product_id');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const type = c.req.query('type');
    const search = (c.req.query('search') ?? '').trim();
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 1000, 1), 5000);

    /* Los productos que calzan con lo buscado. El tope de ids es para que la
       URL de la consulta siguiente no se pase de largo: buscar «a» calzaría
       con el catálogo entero. */
    let idsBuscados: string[] | null = null;
    if (search) {
      const { data: prods } = await db.from('products')
        .select('id').eq('tenant_id', tenantId)
        .or(`name.ilike.%${search}%,sku.ilike.%${search}%`)
        .limit(300);
      idsBuscados = ((prods ?? []) as any[]).map(p => String(p.id));
      /* Ningún producto calza: no hay movimientos que mostrar, y se dice que
         fue por el buscador. */
      if (idsBuscados.length === 0) return ok(c, []);
    }

    let query = db
      .from('stock_adjustments')
      .select('*, product:products(id, name, sku)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (productId) query = query.eq('product_id', productId);
    if (idsBuscados) query = query.in('product_id', idsBuscados);
    if (type) query = query.eq('type', type);
    if (from) query = query.gte('created_at', `${from}T00:00:00`);
    if (to) query = query.lte('created_at', `${to}T23:59:59`);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — registrar ajuste de stock
stockAdjustments.post('/', requirePermission('inventory', 'edit'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json();
    const parsed = AdjustmentSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { product_id, type, quantity, reason, notes, user_email } = parsed.data;

    // 1. Obtener stock actual del producto
    const { data: product, error: pErr } = await db
      .from('products')
      .select('id, stock_quantity, tracks_stock')
      .eq('id', product_id)
      .eq('tenant_id', tenantId)
      .single();

    if (pErr || !product) return fail(c, 'Producto no encontrado', 404);

    const stockBefore = Number(product.stock_quantity ?? 0);
    let stockAfter: number;

    // Calcular nuevo stock según el tipo
    if (type === 'set' || type === 'count') {
      // 'set' o 'count' = nuevo valor absoluto
      stockAfter = quantity;
    } else if (type === 'increase' || type === 'return') {
      stockAfter = stockBefore + Math.abs(quantity);
    } else {
      // decrease, damage, expired, theft → restan
      stockAfter = Math.max(0, stockBefore - Math.abs(quantity));
    }

    const diff = stockAfter - stockBefore;

    // 2. Registrar el ajuste
    const { data: adj, error: aErr } = await db
      .from('stock_adjustments')
      .insert({
        tenant_id: tenantId,
        product_id,
        user_id: userId,
        user_email: user_email ?? null,
        type,
        quantity: diff,
        stock_before: stockBefore,
        stock_after: stockAfter,
        reason,
        notes: notes ?? null,
        source: 'manual',
      })
      .select()
      .single();

    /* Sin la migración 145 la columna `source` no existe y el insert falla
       entero: se reintenta sin ella antes que dejar el ajuste sin registrar. */
    if (aErr && /source/.test(aErr.message ?? '')) {
      const r2 = await db.from('stock_adjustments')
        .insert({
          tenant_id: tenantId, product_id, user_id: userId, user_email: user_email ?? null,
          type, quantity: diff, stock_before: stockBefore, stock_after: stockAfter,
          reason, notes: notes ?? null,
        })
        .select().single();
      if (r2.error) throw new Error(r2.error.message);
      const { error: uErr2 } = await db.from('products')
        .update({ stock_quantity: stockAfter }).eq('id', product_id).eq('tenant_id', tenantId);
      if (uErr2) throw new Error(uErr2.message);
      return ok(c, r2.data, 201);
    }
    if (aErr) throw new Error(aErr.message);

    // 3. Actualizar stock del producto
    const { error: uErr } = await db
      .from('products')
      .update({ stock_quantity: stockAfter })
      .eq('id', product_id)
      .eq('tenant_id', tenantId);

    if (uErr) throw new Error(uErr.message);

    return ok(c, adj, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /physical-count — toma física: aplica un conteo completo en lote.
// Para cada producto contado cuyo valor difiera del stock del sistema, crea un
// ajuste tipo 'count' (valor absoluto) y actualiza el stock. Devuelve el resumen
// de diferencias para poder imprimir/auditar la toma.
const PhysicalCountSchema = z.object({
  counts: z.array(z.object({
    product_id: z.string().uuid(),
    counted: z.number().min(0),
  })).min(1),
  notes: z.string().optional().nullable(),
  user_email: z.string().optional().nullable(),
});

stockAdjustments.post('/physical-count', requirePermission('inventory', 'edit'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json();
    const parsed = PhysicalCountSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const { counts, notes, user_email } = parsed.data;

    // Stock actual de todos los productos contados (una sola consulta).
    const ids = [...new Set(counts.map(x => x.product_id))];
    const { data: products, error: pErr } = await db
      .from('products')
      .select('id, name, sku, stock_quantity')
      .eq('tenant_id', tenantId)
      .in('id', ids);
    if (pErr) throw new Error(pErr.message);
    const byId = new Map((products ?? []).map((p: any) => [p.id, p]));

    const reason = 'Toma física';
    const noteBase = notes?.trim() || null;
    /* Un lote por toma: si la toma se hizo con el producto equivocado, se anula
       completa en vez de deshacer ciento veinte líneas de a una. */
    const loteConteo = crypto.randomUUID();
    const adjRows: any[] = [];
    const items: any[] = [];
    const updates: Array<{ id: string; stock_after: number }> = [];
    let counted = 0, withDiff = 0, unitsBefore = 0, unitsAfter = 0;

    for (const { product_id, counted: cnt } of counts) {
      const p = byId.get(product_id);
      if (!p) continue;
      counted++;
      const stockBefore = Number(p.stock_quantity ?? 0);
      const stockAfter = cnt;
      const diff = stockAfter - stockBefore;
      unitsBefore += stockBefore;
      unitsAfter += stockAfter;
      items.push({ product_id, name: p.name, sku: p.sku, stock_before: stockBefore, counted: stockAfter, diff });
      if (Math.abs(diff) < 0.0001) continue; // sin cambio: no registra ajuste
      withDiff++;
      adjRows.push({
        tenant_id: tenantId, product_id, user_id: userId, user_email: user_email ?? null,
        type: 'count', quantity: diff, stock_before: stockBefore, stock_after: stockAfter,
        reason, notes: noteBase, source: 'manual', batch_id: loteConteo,
      });
      updates.push({ id: product_id, stock_after: stockAfter });
    }

    if (adjRows.length > 0) {
      const { error: aErr } = await insertarAjustes(adjRows);
      if (aErr) throw new Error(aErr.message);
      // Actualiza el stock producto por producto (valores absolutos distintos).
      for (const u of updates) {
        const { error: uErr } = await db.from('products')
          .update({ stock_quantity: u.stock_after })
          .eq('id', u.id).eq('tenant_id', tenantId);
        if (uErr) throw new Error(uErr.message);
      }
    }

    return ok(c, {
      counted, adjusted: withDiff,
      units_before: unitsBefore, units_after: unitsAfter,
      diff_units: unitsAfter - unitsBefore,
      items,
    }, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /waste — MERMA de varios productos de una sola vez.
//
// El ajuste de a uno ya existía, pero al cierre de cocina se botan cinco cosas
// juntas y entrar producto por producto hace que nadie lo registre. Y una merma
// que no se registra no desaparece: reaparece como varianza sin explicar en el
// food cost, que es el peor lugar donde encontrarla.
//
// body: { type: 'damage'|'expired'|'theft'|'decrease', reason, notes?,
//         items: [{ product_id, quantity }] }
const WasteSchema = z.object({
  type: z.enum(['damage', 'expired', 'theft', 'decrease']),
  reason: z.string().min(1),
  notes: z.string().optional().nullable(),
  user_email: z.string().optional().nullable(),
  items: z.array(z.object({
    product_id: z.string().uuid(),
    quantity: z.number().positive(),
  })).min(1),
});

stockAdjustments.post('/waste', requirePermission('inventory', 'edit'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const parsed = WasteSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.errors[0]?.message ?? 'Datos inválidos', 422);
    const { type, reason, notes, user_email, items } = parsed.data;

    const ids = [...new Set(items.map(i => i.product_id))];
    const { data: products, error: pErr } = await db.from('products')
      .select('id, name, stock_quantity, tracks_stock, cost_price')
      .eq('tenant_id', tenantId).in('id', ids);
    if (pErr) throw new Error(pErr.message);
    const byId = new Map((products ?? []).map((p: any) => [p.id, p]));

    const adjRows: any[] = [];
    const applied: any[] = [];
    let totalCost = 0;
    /* Botar cinco cosas al cierre de cocina es UN acto: con el lote se anula
       completo en vez de línea por línea. */
    const loteMerma = crypto.randomUUID();

    for (const it of items) {
      const p = byId.get(it.product_id);
      if (!p) continue;
      // Un producto de stock infinito no tiene existencias que botar. Se omite en
      // vez de fallar: en una lista de diez, una línea así no debe tumbar el resto.
      if ((p as any).tracks_stock === false) continue;

      const before = Number((p as any).stock_quantity ?? 0);
      const after = before - it.quantity;
      const cost = (Number((p as any).cost_price) || 0) * it.quantity;
      totalCost += cost;

      adjRows.push({
        tenant_id: tenantId, product_id: it.product_id, user_id: userId ?? null,
        user_email: user_email ?? null, type,
        quantity: -it.quantity, stock_before: before, stock_after: after,
        reason, notes: notes ?? null,
        source: 'manual', batch_id: loteMerma,
      });
      applied.push({ product_id: it.product_id, name: (p as any).name, quantity: it.quantity, cost });
    }

    if (adjRows.length === 0) return fail(c, 'Ninguno de los productos lleva control de stock.', 422);

    // La bitácora primero: si no se puede registrar el porqué, no se toca el stock.
    const { error: aErr } = await insertarAjustes(adjRows);
    if (aErr) throw new Error(aErr.message);

    for (const r of adjRows) {
      await db.from('products')
        .update({ stock_quantity: r.stock_after, updated_at: new Date().toISOString() })
        .eq('id', r.product_id).eq('tenant_id', tenantId);
    }

    return ok(c, { registered: applied.length, total_cost: totalCost, items: applied, batch_id: loteMerma }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * ¿Este movimiento se puede anular desde el reporte de movimientos?
 *
 * No todos. La recepción de una compra se deshace ANULANDO LA COMPRA, y el
 * sobrante de una ruta se corrige en la ruta: revertir el stock de este lado
 * dejaría la compra diciendo «recibida» con la mercadería ya devuelta, o la
 * ruta cerrada contra existencias que ya no están. Esos movimientos son el
 * rastro de otro documento, no un acto suelto.
 *
 * `source` lo escriben los que crean el movimiento. Los movimientos VIEJOS no
 * la tienen (NULL), así que para ellos se cae al texto del motivo, que es lo
 * único que hay. Es una heurística y por eso solo se usa como respaldo.
 */
function origenDelMovimiento(a: any): string {
  const src = String(a?.source ?? '').trim();
  if (src) return src;
  const motivo = String(a?.reason ?? '').toLowerCase();
  if (/^compra |^recarga de compra |recepci[oó]n de compra/.test(motivo)) return 'purchase';
  if (/anulaci[oó]n de compra/.test(motivo)) return 'purchase';
  if (/sobrante de ruta|devoluci[oó]n al cerrar la ruta/.test(motivo)) return 'route';
  if (/nota de cr[eé]dito de proveedor/.test(motivo)) return 'supplier_nc';
  return 'manual';
}

const DONDE_SE_DESHACE: Record<string, string> = {
  purchase: 'Este movimiento es la recepción de una compra: se deshace anulando la compra, para que la compra y el inventario no se contradigan.',
  route: 'Este movimiento salió del cierre de una ruta: se corrige en la ruta, no acá.',
  supplier_nc: 'Este movimiento salió de una nota de crédito de proveedor: se corrige en el documento recibido.',
};

/**
 * Revierte el efecto en el stock de un movimiento ya aplicado.
 *
 * Se revierte por el DELTA (`quantity`), nunca volviendo a `stock_before`:
 * poner el stock en el valor anterior borraría de un golpe todos los
 * movimientos posteriores —las ventas del día incluidas—. Restar el delta deja
 * el inventario como si ese movimiento nunca hubiera pasado y respeta todo lo
 * que vino después.
 */
async function revertirMovimiento(tenantId: string, a: any): Promise<{ ok: boolean; mensaje?: string; queda?: number }> {
  const delta = Number(a.quantity ?? 0);
  const { data: prod } = await db.from('products')
    .select('id, stock_quantity, name').eq('id', a.product_id).eq('tenant_id', tenantId).maybeSingle();
  if (!prod) return { ok: false, mensaje: 'El producto del movimiento ya no existe' };

  const actual = Number((prod as any).stock_quantity ?? 0);
  const queda = actual - delta;
  const { error } = await db.from('products')
    .update({ stock_quantity: queda, updated_at: new Date().toISOString() })
    .eq('id', a.product_id).eq('tenant_id', tenantId);
  if (error) return { ok: false, mensaje: error.message };
  return { ok: true, queda };
}

/**
 * POST /:id/void — ANULAR un movimiento de inventario o una merma.
 *
 * Qué hace, en este orden:
 *  1. Reclama el movimiento (marca `voided_at` solo si estaba sin anular). Dos
 *     clics del mismo botón —o dos usuarios a la vez— revertirían el stock dos
 *     veces y el inventario quedaría al doble.
 *  2. Revierte el stock por el delta.
 *  3. Si el stock queda NEGATIVO, no lo esconde: lo dice en la respuesta. Pasa
 *     cuando se anula una entrada cuya mercadería ya se vendió, y es
 *     información real que el encargado necesita, no un error a tapar.
 *
 * `?batch=1` anula TODO el lote de una merma registrada de una sola vez: botar
 * cinco cosas al cierre de cocina es un solo acto y se deshace como uno solo.
 */
stockAdjustments.post('/:id/void', requirePermission('inventory', 'delete'), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const { id } = c.req.param();
    const enLote = ['1', 'true', 'si'].includes(String(c.req.query('batch') ?? '').toLowerCase());
    const motivo = String((await c.req.json().catch(() => ({} as any)))?.reason ?? '').trim();

    const { data: encontrado, error: eBase } = await db.from('stock_adjustments')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (eBase) throw new Error(eBase.message);

    /* El id puede ser el de un LOTE y no el de una fila: es lo que devuelve la
       merma rápida al registrarla, y así el «deshacer» de esa pantalla funciona
       sin tener que ir a buscar el id de la primera línea. */
    let base: any = encontrado;
    if (!base) {
      const { data: porLote } = await db.from('stock_adjustments')
        .select('*').eq('tenant_id', tenantId).eq('batch_id', id).is('voided_at', null).limit(1);
      base = (porLote ?? [])[0] ?? null;
    }
    if (!base) return fail(c, 'Movimiento no encontrado', 404);

    const origen = origenDelMovimiento(base);
    if (DONDE_SE_DESHACE[origen]) return fail(c, DONDE_SE_DESHACE[origen], 409);
    if ((base as any).voided_at) return fail(c, 'Este movimiento ya estaba anulado', 409);

    // Las filas a anular: una, o el lote completo de la merma.
    let filas: any[] = [base];
    const batchId = (base as any).batch_id;
    if (enLote && batchId) {
      const { data: lote } = await db.from('stock_adjustments')
        .select('*').eq('tenant_id', tenantId).eq('batch_id', batchId).is('voided_at', null);
      if ((lote ?? []).length > 0) filas = lote as any[];
    }

    const anulados: any[] = [];
    const negativos: any[] = [];
    const fallaron: any[] = [];

    for (const a of filas) {
      if (DONDE_SE_DESHACE[origenDelMovimiento(a)]) continue;

      /* RECLAMO ATÓMICO: el `is('voided_at', null)` es lo que impide que dos
         clics seguidos reviertan el mismo movimiento dos veces. Si no devuelve
         fila, alguien más llegó primero y acá no se toca el stock. */
      const upd = await db.from('stock_adjustments')
        .update({
          voided_at: new Date().toISOString(),
          voided_by: userId ?? null,
          void_reason: motivo || null,
        })
        .eq('id', a.id).eq('tenant_id', tenantId).is('voided_at', null)
        .select();
      if (upd.error) {
        // La migración 145 sin correr: no se puede anular sin dónde anotarlo.
        if (/voided_at|void_reason|voided_by/.test(upd.error.message ?? '')) {
          return fail(c, 'Falta correr la migración 145 para poder anular movimientos', 409);
        }
        fallaron.push({ id: a.id, error: upd.error.message });
        continue;
      }
      if ((upd.data ?? []).length === 0) continue;   // otro lo anuló primero

      const r = await revertirMovimiento(tenantId, a);
      if (!r.ok) {
        /* No se pudo mover el stock: se DESANULA, porque un movimiento marcado
           como anulado cuyo efecto sigue aplicado es peor que no haberlo
           anulado —el reporte diría una cosa y el inventario otra—. */
        await db.from('stock_adjustments')
          .update({ voided_at: null, voided_by: null, void_reason: null })
          .eq('id', a.id).eq('tenant_id', tenantId);
        fallaron.push({ id: a.id, error: r.mensaje ?? 'No se pudo revertir el stock' });
        continue;
      }
      anulados.push({ id: a.id, product_id: a.product_id, quantity: Number(a.quantity ?? 0), stock_queda: r.queda });
      if ((r.queda ?? 0) < 0) negativos.push({ product_id: a.product_id, stock: r.queda });
    }

    if (anulados.length === 0) {
      return fail(c, fallaron[0]?.error ?? 'No se pudo anular el movimiento', 409);
    }

    return ok(c, {
      anulados: anulados.length,
      movimientos: anulados,
      /* El stock negativo se dice, no se acomoda: se anuló una entrada cuya
         mercadería ya salió, y eso hay que saberlo. */
      negativos,
      fallaron,
      aviso: negativos.length > 0
        ? 'Hay productos con stock negativo: la mercadería de esa entrada ya había salido. Revisá esas existencias.'
        : null,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /kardex?product_id=&from=&to= — Kardex (tarjeta de existencias) de un
// producto: todos los movimientos con saldo corrido. Fuentes:
//   • stock_adjustments → ajustes, tomas físicas y recepciones de compra.
//   • invoice_items      → ventas (salidas), excluyendo anuladas y ventas de ruta.
// El saldo se reconstruye desde el stock actual hacia atrás para que la última
// fila cierre exactamente en el stock real del sistema.
stockAdjustments.get('/kardex', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const productId = c.req.query('product_id');
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!productId) return fail(c, 'Falta product_id', 400);

    // Producto + stock actual (cierre del kardex).
    const { data: product, error: pErr } = await db.from('products')
      .select('id, name, sku, stock_quantity, tracks_stock')
      .eq('id', productId).eq('tenant_id', tenantId).maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!product) return fail(c, 'Producto no encontrado', 404);

    type Mov = { date: string; kind: string; label: string; ref: string; delta: number };
    const movs: Mov[] = [];

    // 1) Ajustes (incluye compras recibidas y tomas físicas).
    /* Los movimientos ANULADOS no van al kardex: su efecto en el stock ya se
       revirtió, así que dejarlos descuadraría el saldo corrido contra el stock
       real. Si la migración 145 no corrió, no hay anulados que excluir. */
    let adjQ: any = await db.from('stock_adjustments')
      .select('type, quantity, reason, created_at')
      .eq('tenant_id', tenantId).eq('product_id', productId).is('voided_at', null);
    if (adjQ.error && /voided_at/.test(adjQ.error.message ?? '')) {
      adjQ = await db.from('stock_adjustments')
        .select('type, quantity, reason, created_at')
        .eq('tenant_id', tenantId).eq('product_id', productId);
    }
    const adj = adjQ.data;
    for (const a of (adj ?? []) as any[]) {
      movs.push({
        date: a.created_at, kind: a.type, label: a.reason || a.type,
        ref: '', delta: Number(a.quantity ?? 0),
      });
    }

    // 2) Ventas (salidas). Ítems del producto → facturas no anuladas y sin ruta.
    const { data: items } = await db.from('invoice_items')
      .select('quantity, invoice_id').eq('product_id', productId);
    const invIds = [...new Set((items ?? []).map((i: any) => i.invoice_id).filter(Boolean))];
    const invById = new Map<string, any>();
    const CH = 300;
    for (let i = 0; i < invIds.length; i += CH) {
      const { data: invs } = await db.from('invoices')
        .select('id, invoice_number, status, issued_at, created_at, route_id')
        .eq('tenant_id', tenantId).in('id', invIds.slice(i, i + CH));
      for (const v of (invs ?? []) as any[]) invById.set(v.id, v);
    }
    for (const it of (items ?? []) as any[]) {
      const inv = invById.get(it.invoice_id);
      if (!inv) continue;
      if (inv.status === 'cancelled') continue;   // anulada: la salida se revirtió
      if (inv.route_id) continue;                  // venta de ruta: no toca stock central
      movs.push({
        date: inv.issued_at || inv.created_at, kind: 'sale', label: 'Venta',
        ref: inv.invoice_number || '', delta: -Number(it.quantity ?? 0),
      });
    }

    // Orden cronológico ascendente.
    movs.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Saldo inicial = stock actual − suma de todos los deltas.
    const currentStock = Number(product.stock_quantity ?? 0);
    const totalDelta = movs.reduce((s, m) => s + m.delta, 0);
    const opening = currentStock - totalDelta;

    // Saldo corrido sobre TODO el historial.
    let bal = opening;
    const withBalance = movs.map(m => {
      bal += m.delta;
      return {
        date: m.date, kind: m.kind, label: m.label, ref: m.ref,
        in: m.delta > 0 ? m.delta : 0,
        out: m.delta < 0 ? -m.delta : 0,
        balance: bal,
      };
    });

    // Filtro por rango (para la vista); el saldo inicial mostrado es el previo
    // a la primera fila visible.
    const inRange = withBalance.filter(m => {
      if (from && m.date < `${from}T00:00:00`) return false;
      if (to && m.date > `${to}T23:59:59`) return false;
      return true;
    });
    const openingShown = inRange.length > 0
      ? inRange[0].balance - inRange[0].in + inRange[0].out
      : currentStock;
    const totalIn = inRange.reduce((s, m) => s + m.in, 0);
    const totalOut = inRange.reduce((s, m) => s + m.out, 0);

    return ok(c, {
      product: { id: product.id, name: product.name, sku: product.sku, tracks_stock: product.tracks_stock },
      opening: openingShown,
      closing: currentStock,
      total_in: totalIn,
      total_out: totalOut,
      rows: inRange,
    });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default stockAdjustments;
