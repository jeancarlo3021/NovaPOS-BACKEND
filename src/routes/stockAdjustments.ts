import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

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
stockAdjustments.post('/', async (c) => {
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

export default stockAdjustments;
