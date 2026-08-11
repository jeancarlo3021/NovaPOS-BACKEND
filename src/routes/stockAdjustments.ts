import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { requirePermission } from '../middleware/permissions.js';

const stockAdjustments = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const AdjustmentSchema = z.object({
  product_id: z.string().uuid(),
  type: z.enum(['increase', 'decrease', 'set', 'damage', 'expired', 'theft', 'return', 'count']),
  quantity: z.number(),                // diferencia a aplicar (puede ser negativa para decrease)
  reason: z.string().min(1),
  notes: z.string().optional().nullable(),
  user_email: z.string().optional().nullable(),
});

// GET / — listar ajustes (con filtros opcionales)
stockAdjustments.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const productId = c.req.query('product_id');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const type = c.req.query('type');

    let query = db
      .from('stock_adjustments')
      .select('*, product:products(id, name, sku)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (productId) query = query.eq('product_id', productId);
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
      })
      .select()
      .single();

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
        reason, notes: noteBase,
      });
      updates.push({ id: product_id, stock_after: stockAfter });
    }

    if (adjRows.length > 0) {
      const { error: aErr } = await db.from('stock_adjustments').insert(adjRows);
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
      });
      applied.push({ product_id: it.product_id, name: (p as any).name, quantity: it.quantity, cost });
    }

    if (adjRows.length === 0) return fail(c, 'Ninguno de los productos lleva control de stock.', 422);

    // La bitácora primero: si no se puede registrar el porqué, no se toca el stock.
    const { error: aErr } = await db.from('stock_adjustments').insert(adjRows);
    if (aErr) throw new Error(aErr.message);

    for (const r of adjRows) {
      await db.from('products')
        .update({ stock_quantity: r.stock_after, updated_at: new Date().toISOString() })
        .eq('id', r.product_id).eq('tenant_id', tenantId);
    }

    return ok(c, { registered: applied.length, total_cost: totalCost, items: applied }, 201);
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
    const { data: adj } = await db.from('stock_adjustments')
      .select('type, quantity, reason, created_at').eq('tenant_id', tenantId).eq('product_id', productId);
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
