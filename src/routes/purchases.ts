import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const purchases = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const ItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity:   z.number().positive(),
  unit_price: z.number().nonnegative(),
  subtotal:   z.number().nonnegative().optional().nullable(),
});

const PurchaseSchema = z.object({
  supplier_id:            z.string().uuid(),
  /**
   * Opcional: una compra que YA llegó se registra con la factura del proveedor
   * en la mano, y obligar a inventar un número de orden que nunca existió es
   * pedirle al usuario que se invente un dato. Si no viene, se genera.
   */
  purchase_number:        z.string().min(1).optional().nullable(),
  purchase_date:          z.string(),
  expected_delivery_date: z.string().optional().nullable(),
  notes:                  z.string().optional().nullable(),
  total_amount:           z.number().nonnegative().optional().nullable(),
  items:                  z.array(ItemSchema).optional().default([]),
  /**
   * COMPRA SIN ORDEN: la mercadería ya está acá.
   *
   * El flujo obligaba a crear una orden y después «recibirla», un paso que en
   * la práctica es puro trámite —de las compras recibidas, 23 de 29 se crearon
   * y recibieron el mismo día— y que además deja trampas: hay 48 compras
   * atascadas en «pendiente», o sea mercadería que entró y un inventario que
   * nunca se enteró. Con esto la compra entra ya recibida: sube el stock,
   * actualiza el costo y crea la cuenta por pagar en un solo paso.
   */
  receive_now:            z.boolean().optional().default(false),
  /** El plan puede no permitir mover inventario. */
  canUpdateStock:         z.boolean().optional().default(true),
});

/**
 * Siguiente número de compra del negocio.
 *
 * Mismo formato que venía generando el frontend (COM-0001). Acá también,
 * porque una compra directa puede llegar sin número: el del proveedor va en
 * las notas o en su propia factura, y este es el consecutivo interno.
 */
async function siguienteNumeroDeCompra(tenantId: string): Promise<string> {
  try {
    const { data } = await db.from('purchases')
      .select('purchase_number').eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }).limit(200);
    let max = 0;
    for (const r of (data ?? []) as any[]) {
      const n = parseInt(String(r.purchase_number ?? '').split('-').pop() ?? '', 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return `COM-${String(max + 1).padStart(4, '0')}`;
  } catch {
    return `COM-${Date.now().toString().slice(-6)}`;
  }
}

purchases.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status   = c.req.query('status');
    const from     = c.req.query('from');
    const to       = c.req.query('to');

    let query = db.from('purchases')
      .select('id, supplier_id, purchase_number, purchase_date, status, total_amount, notes')
      .eq('tenant_id', tenantId)
      .order('purchase_date', { ascending: false });
    if (status) query = query.eq('status', status);
    if (from) query = query.gte('purchase_date', from);
    if (to) query = query.lte('purchase_date', to);

    const { data: purchases, error } = await query;
    if (error) throw new Error(error.message);

    // Get supplier names
    const supplierIds = [...new Set((purchases ?? []).map((p: any) => p.supplier_id))];
    const { data: suppliers } = await db.from('suppliers')
      .select('id, name').in('id', supplierIds);

    const result = (purchases ?? []).map((p: any) => ({
      ...p,
      supplier: (suppliers ?? []).find((s: any) => s.id === p.supplier_id) || null,
    }));

    return ok(c, result);
  } catch (err: any) { return fail(c, err.message, 500); }
});

purchases.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();

    // Get purchase
    const { data: purchase, error: pErr } = await db.from('purchases')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (pErr) throw new Error(pErr.message);
    if (!purchase) return fail(c, 'Compra no encontrada', 404);

    // Get supplier name
    const { data: supplier, error: sErr } = await db.from('suppliers')
      .select('name')
      .eq('id', purchase.supplier_id)
      .maybeSingle();

    if (sErr) console.error('Error fetching supplier:', sErr);

    // Get items for this purchase
    const { data: purchaseItems, error: iErr } = await db.from('purchase_items')
      .select('*')
      .eq('purchase_id', id);

    if (iErr) {
      console.error('Error fetching items:', iErr);
      return fail(c, 'Error al obtener items: ' + iErr.message, 500);
    }

    return ok(c, {
      ...purchase,
      suppliers: supplier ? { name: supplier.name } : null,
      purchase_items: purchaseItems || []
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

purchases.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = PurchaseSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { items, receive_now: recibirYa, canUpdateStock, ...purchaseData } = parsed.data;

    // Sin número, se genera uno: ver el comentario del esquema.
    const numero = String(purchaseData.purchase_number ?? '').trim()
      || await siguienteNumeroDeCompra(tenantId);

    const { data: purchase, error: pErr } = await db.from('purchases')
      .insert({ ...purchaseData, purchase_number: numero, tenant_id: tenantId, status: 'pending' })
      .select().single();
    if (pErr) throw new Error(pErr.message);

    const itemRows = items.map(item => ({ ...item, purchase_id: purchase.id }));
    if (itemRows.length > 0) {
      const { error: iErr } = await db.from('purchase_items').insert(itemRows);
      if (iErr) throw new Error(iErr.message);
    }

    if (recibirYa) {
      /**
       * Se crea pendiente y se recibe acto seguido, en vez de insertarla ya
       * «received»: así pasa por el MISMO camino que una recepción normal
       * —stock, costo y cuenta por pagar—. Una compra directa que tomara un
       * atajo sería la que se olvida de actualizar el costo.
       */
      const recibida = await aplicarRecepcion({
        tenantId, userId: c.get('userId'), purchaseId: purchase.id,
        items: items.map(i => ({ product_id: i.product_id, quantity: i.quantity })),
        canUpdateStock,
      });
      return ok(c, recibida, 201);
    }

    return ok(c, purchase, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

purchases.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const body     = await c.req.json();
    const { data, error } = await db.from('purchases')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * APLICA LA RECEPCIÓN de una compra: marca recibida, sube el stock, actualiza
 * el costo y crea la cuenta por pagar si el proveedor es a crédito.
 *
 * Vive en una función y no dentro del endpoint porque ahora hay DOS caminos que
 * terminan acá: recibir una orden que estaba pendiente, y registrar una compra
 * que ya llegó (sin orden previa). Duplicar esto era garantizar que uno de los
 * dos se quedara sin actualizar el costo o sin crear la cuenta por pagar.
 */
async function aplicarRecepcion(params: {
  tenantId: string;
  userId?: string | null;
  purchaseId: string;
  items: Array<{ product_id: string; quantity: number }>;
  canUpdateStock?: boolean;
  notes?: string | null;
}): Promise<any> {
  const { tenantId, userId, purchaseId: id, items, canUpdateStock = true, notes } = params;

  const { data: purchase, error: pErr } = await db.from('purchases')
    .select('*')
    .eq('id', id).eq('tenant_id', tenantId).single();
  if (pErr) throw new Error(`Error fetching purchase: ${pErr.message}`);
  if (!purchase) throw new Error('Compra no encontrada');

  const { data: supplier } = await db.from('suppliers')
    .select('name, payment_terms')
    .eq('id', purchase.supplier_id)
    .maybeSingle();

  // Marcar recibida.
  const { data: updated, error: uErr } = await db.from('purchases')
    .update({
      status: 'received',
      actual_delivery_date: new Date().toISOString().slice(0, 10),
      ...(notes !== undefined ? { notes: notes || null } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id).eq('tenant_id', tenantId).select().single();
  if (uErr) throw new Error(`Error updating purchase: ${uErr.message}`);

  // Incrementar stock por item, respetando tracks_stock por producto.
  // Cada incremento queda registrado en stock_adjustments para trazabilidad.
  if (canUpdateStock) {
    let touched = 0;
    let skipped = 0;

    // Precio pagado por unidad, tomado de la COMPRA y no del body: quien llama
    // manda solo producto y cantidad, y el costo tiene que salir de lo que
    // quedó registrado.
    const costByProduct = new Map<string, number>();
    try {
      const { data: pItems } = await db.from('purchase_items')
        .select('product_id, unit_price').eq('purchase_id', id);
      for (const pi of (pItems ?? []) as any[]) {
        const v = Number(pi.unit_price) || 0;
        if (pi.product_id && v > 0) costByProduct.set(String(pi.product_id), v);
      }
    } catch (e: any) {
      console.warn('[RECEIVE] no se pudo leer el costo de la compra:', e?.message);
    }

    for (const item of (items ?? [])) {
      const qty = Number(item.quantity ?? 0);
      if (!qty || qty <= 0) continue;

      const { data: prod } = await db.from('products')
        .select('stock_quantity, tracks_stock, name')
        .eq('id', item.product_id)
        .single();
      if (!prod) continue;

      // Producto sin control de stock → no se toca ni se loguea.
      if (prod.tracks_stock === false) { skipped++; continue; }

      const stockBefore = Number(prod.stock_quantity ?? 0);
      const stockAfter  = stockBefore + qty;

      // ── Costo del producto ────────────────────────────────────────────
      // Se usa el precio de ESTA compra, no un promedio ponderado: es lo que
      // el negocio acaba de pagar y lo que va a pagar la próxima vez. Un
      // promedio suaviza justo la subida que hay que ver.
      const unitCost = costByProduct.get(String(item.product_id)) ?? 0;
      const costPatch = unitCost > 0 ? { cost_price: unitCost } : {};

      const { error: upErr } = await db.from('products').update({
        stock_quantity: stockAfter,
        ...costPatch,
        updated_at: new Date().toISOString(),
      }).eq('id', item.product_id);
      if (upErr) {
        console.error(`[RECEIVE] ERROR updating stock for ${item.product_id}:`, upErr.message);
        continue;
      }

      const { error: adjErr } = await db.from('stock_adjustments').insert({
        tenant_id: tenantId,
        product_id: item.product_id,
        user_id: userId ?? null,
        type: 'increase',
        quantity: qty,
        stock_before: stockBefore,
        stock_after: stockAfter,
        reason: `Compra ${purchase.purchase_number ?? ''}`.trim(),
        notes: supplier?.name ? `Recepción de ${supplier.name}` : 'Recepción de compra',
      });
      if (adjErr) console.error(`[RECEIVE] ERROR logging stock_adjustment for ${item.product_id}:`, adjErr.message);

      touched++;
    }
    console.log(`[RECEIVE] Stock incremented for ${touched} items, ${skipped} skipped (tracks_stock=false)`);
  }

  // Cuenta por pagar si el proveedor es a crédito.
  const paymentTerms = supplier?.payment_terms;
  if (paymentTerms && paymentTerms.trim().toLowerCase() !== 'contado') {
    const dueDate = calculateDueDate(purchase.purchase_date, paymentTerms);
    const { error: apErr } = await db.from('accounts_payable').insert({
      tenant_id: tenantId,
      purchase_id: id,
      supplier_id: purchase.supplier_id,
      purchase_number: purchase.purchase_number,
      supplier_name: supplier?.name ?? 'Proveedor desconocido',
      total_amount: purchase.total_amount ?? 0,
      paid_amount: 0,
      due_date: dueDate,
      status: 'pending',
      payment_terms: paymentTerms,
      notes: purchase.notes,
    });
    if (apErr) console.error('[RECEIVE] ERROR creating AP:', apErr.message);
  }

  return updated;
}

// POST /:id/receive — recibe una orden pendiente.
purchases.post('/:id/receive', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const body = await c.req.json() as { items: { product_id: string; quantity: number }[]; canUpdateStock?: boolean; notes?: string };
    const updated = await aplicarRecepcion({
      tenantId, userId: c.get('userId'), purchaseId: id,
      items: body.items ?? [], canUpdateStock: body.canUpdateStock ?? true, notes: body.notes,
    });
    return ok(c, updated);
  } catch (err: any) {
    console.error('[RECEIVE] ERROR:', err.message);
    return fail(c, err.message, 500);
  }
});

// Helper to calculate due date from payment terms
function calculateDueDate(baseDate: string, terms: string): string {
  const match = terms.match(/(\d+)/);
  if (!match) return baseDate;
  const days = parseInt(match[1]);
  const date = new Date(baseDate);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

purchases.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const { data, error } = await db.from('purchases')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default purchases;
