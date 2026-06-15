import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const invoices = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// CartItem from frontend has extra fields (product, promo) — accept any object with product_id
const ItemSchema = z.object({
  product_id:       z.string().uuid(),
  quantity:         z.number().positive(),
  unit_price:       z.number().nonnegative(),
  discount_percent: z.number().nonnegative().optional().default(0),
  discount_amount:  z.number().nonnegative().optional().default(0),
  subtotal:         z.number().nonnegative(),
}).passthrough(); // ignore extra fields like 'product', 'promo'

const InvoiceSchema = z.object({
  cash_session_id:  z.string().uuid(),
  customer_id:      z.string().uuid().optional().nullable(),
  invoice_number:   z.string().optional().nullable(), // auto-generated if absent
  customer_name:    z.string().optional().nullable(),
  customer_email:   z.string().optional().nullable(),
  customer_phone:   z.string().optional().nullable(),
  subtotal:         z.number().nonnegative(),
  discount_amount:  z.number().nonnegative().optional().default(0),
  discount_percent: z.number().nonnegative().optional().default(0),
  tax_percent:      z.number().nonnegative().optional().default(13),
  tax_amount:       z.number().nonnegative().default(0),
  total:            z.number().nonnegative(),
  payment_method:   z.enum(['cash', 'card', 'sinpe', 'check', 'transfer']).default('cash'),
  status:           z.enum(['draft', 'completed', 'cancelled']).default('completed'),
  notes:            z.string().optional().nullable(),
  issued_at:        z.string().optional().nullable(),
  amount_received:  z.number().optional().nullable(),
  change_amount:    z.number().optional().nullable(),
  voucher_number:   z.string().optional().nullable(),
  /** Cajero activo (kiosk mode). Si llega, sobreescribe el user del JWT. */
  cashier_id:       z.string().uuid().optional().nullable(),
  cashier_name:     z.string().optional().nullable(),
  /** Pagos mixtos: array de splits. Si llega, payment_method queda como el
   *  dominante y la columna `payments` se llena con el array completo. */
  payments:         z.array(z.object({
                      method: z.enum(['cash', 'card', 'sinpe']),
                      amount: z.number().positive(),
                      voucher_number: z.string().optional().nullable(),
                    })).optional().nullable(),
  items:            z.array(ItemSchema).min(1),
});

// Genera el próximo número de factura ÚNICO por tenant.
// Formato: YYYYMMDD-NNNNN. Toma el MÁXIMO consecutivo del día para ese tenant
// (no un simple conteo) — así no choca con números offline ni con huecos.
// `attemptOffset` permite reintentar con el siguiente número ante colisión.
async function nextInvoiceNumber(tenantId: string, attemptOffset = 0): Promise<string> {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  // Traer los números del día de ESTE tenant y calcular el mayor sufijo usado.
  const { data } = await db.from('invoices')
    .select('invoice_number')
    .eq('tenant_id', tenantId)
    .gte('created_at', todayStart)
    .lt('created_at', todayEnd);

  let maxSeq = 0;
  for (const r of (data ?? []) as any[]) {
    const m = String(r.invoice_number ?? '').match(/-(\d+)$/);
    if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
  }

  return `${datePart}-${String(maxSeq + 1 + attemptOffset).padStart(5, '0')}`;
}

invoices.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from  = c.req.query('from');
    const to    = c.req.query('to');
    const page  = Number(c.req.query('page') ?? 1);
    const limit = Number(c.req.query('limit') ?? 50);

    let query = db.from('invoices').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('issued_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    if (from) query = query.gte('issued_at', from);
    if (to)   query = query.lte('issued_at', to);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    return ok(c, { invoices: data, total: count, page, limit });
  } catch (err: any) { return fail(c, err.message, 500); }
});

invoices.get('/next-number', async (c) => {
  try {
    const num = await nextInvoiceNumber(c.get('tenantId'));
    return ok(c, { invoice_number: num });
  } catch (err: any) { return fail(c, err.message, 500); }
});

invoices.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data, error } = await db.from('invoices').select('*, invoice_items(*)')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(typeof error === 'string' ? error : (error as any).message || JSON.stringify(error));
    if (!data) return fail(c, 'Factura no encontrada', 404);

    // Hidratar nombre del producto en cada item y exponer también como `items`
    // (el frontend de reimpresión espera `items[].product_name`).
    const rawItems = (data as any).invoice_items ?? [];
    const productIds = Array.from(new Set(rawItems.map((it: any) => it.product_id).filter(Boolean)));
    let nameById = new Map<string, string>();
    if (productIds.length > 0) {
      const { data: prods } = await db.from('products')
        .select('id, name').in('id', productIds);
      for (const p of (prods ?? []) as any[]) nameById.set(p.id, p.name);
    }
    const items = rawItems.map((it: any) => ({
      ...it,
      product_name: it.product_name ?? nameById.get(it.product_id) ?? 'Producto',
    }));

    return ok(c, { ...data, items, invoice_items: items });
  } catch (err: any) { return fail(c, err.message, 500); }
});

invoices.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const callerUserId = c.get('userId');
    const raw = await c.req.json();
    const parsed = InvoiceSchema.safeParse(raw);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { items, invoice_number, ...invoiceData } = parsed.data;

    // Cajero atribuido: si vino cashier_id (kiosk mode), usamos ese; si no,
    // el user del JWT. Esto permite que el reporte de cajeros muestre quién
    // operó cada venta en un terminal compartido.
    const attributedCashierId   = invoiceData.cashier_id   ?? callerUserId ?? null;
    const attributedCashierName = invoiceData.cashier_name ?? null;

    // Insert con reintento ante colisión de número (unique tenant_id+invoice_number).
    // Puede chocar si: 2 ventas casi simultáneas, o una venta offline trae un
    // número que ya existe online. Reintentamos regenerando el consecutivo.
    let inv: any = null;
    let invErr: any = null;
    // Número inicial: el que vino (offline) o el siguiente consecutivo.
    let finalNumber = (invoice_number?.trim()) || await nextInvoiceNumber(tenantId);

    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await db.from('invoices').insert({
        ...invoiceData,
        cashier_id:     attributedCashierId,
        cashier_name:   attributedCashierName,
        tenant_id:      tenantId,
        invoice_number: finalNumber,
        issued_at:      invoiceData.issued_at ?? new Date().toISOString(),
      }).select().single();

      if (!res.error) { inv = res.data; invErr = null; break; }

      invErr = res.error;
      const msg = (res.error as any)?.message ?? '';
      const isDup = (res.error as any)?.code === '23505' || /duplicate key|invoice_number_key/i.test(msg);
      if (!isDup) break;  // otro error → no reintentar

      // Colisión: regenerar tomando el siguiente consecutivo (offset crece por intento).
      finalNumber = await nextInvoiceNumber(tenantId, attempt + 1);
    }
    if (invErr) throw new Error(invErr.message);
    if (!inv) throw new Error('No se pudo generar la factura (número duplicado)');

    // Insert items (strip extra CartItem fields)
    const itemRows = items.map((item: any) => ({
      invoice_id:       inv.id,
      product_id:       item.product_id,
      quantity:         item.quantity,
      unit_price:       item.unit_price,
      discount_percent: item.discount_percent ?? 0,
      discount_amount:  item.discount_amount ?? 0,
      subtotal:         item.subtotal,
    }));
    const { error: itemErr } = await db.from('invoice_items').insert(itemRows);
    if (itemErr) throw new Error(itemErr.message);

    // Decrement stock — SOLO productos que manejan inventario.
    // Los de stock infinito (tracks_stock === false) NO se descuentan.
    for (const item of items as any[]) {
      const { data: p } = await db.from('products')
        .select('stock_quantity, tracks_stock').eq('id', item.product_id).maybeSingle();
      if (p && (p as any).tracks_stock !== false) {
        await db.from('products').update({
          stock_quantity: Math.max(0, (p.stock_quantity ?? 0) - Number(item.quantity)),
          updated_at: new Date().toISOString(),
        }).eq('id', item.product_id);
      }
    }

    return ok(c, inv, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

invoices.post('/:id/void', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    // 1) Verificar estado actual: rechazar si la factura ya está anulada o
    //    si es un draft, para que no se pueda anular dos veces el mismo recibo.
    const { data: current, error: readErr } = await db.from('invoices')
      .select('id, status, invoice_number')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!current) return fail(c, 'Factura no encontrada', 404);
    if (current.status === 'cancelled') {
      return fail(c, `La factura ${current.invoice_number} ya estaba anulada`, 409);
    }
    if (current.status !== 'completed') {
      return fail(c, `Solo se pueden anular facturas completadas (estado actual: ${current.status})`, 409);
    }

    // 2) Marcar como anulada de forma idempotente: solo actualiza si sigue en 'completed'.
    const { data, error } = await db.from('invoices')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).eq('status', 'completed')
      .select().single();
    if (error) throw new Error(error.message);
    if (!data) {
      // Otro request ganó la carrera y la anuló primero.
      return fail(c, 'La factura ya fue anulada por otra sesión', 409);
    }

    // 3) Devolver el stock al inventario — SOLO productos que rastrean stock.
    //    Los de stock infinito (tracks_stock=false) no se tocan.
    const { data: items } = await db.from('invoice_items')
      .select('product_id, quantity').eq('invoice_id', id);
    for (const it of (items ?? []) as any[]) {
      if (!it.product_id) continue;
      const { data: p } = await db.from('products')
        .select('stock_quantity, tracks_stock').eq('id', it.product_id).maybeSingle();
      if (p && (p as any).tracks_stock !== false) {
        await db.from('products').update({
          stock_quantity: (p.stock_quantity ?? 0) + Number(it.quantity),
          updated_at: new Date().toISOString(),
        }).eq('id', it.product_id);
      }
    }

    // 4) Revertir el movimiento de caja: registrar la salida por la anulación
    //    para que el cierre de caja cuadre (la venta había sumado efectivo).
    if ((data as any).cash_session_id) {
      try {
        await db.from('cash_movements').insert({
          cash_session_id:  (data as any).cash_session_id,
          type:             'out',
          amount:           Number((data as any).total ?? 0),
          description:      `Anulación factura ${(data as any).invoice_number}`,
          reference_id:     id,
        });
      } catch (e) {
        console.warn('[void] no se pudo registrar movimiento de caja:', e);
      }
    }

    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default invoices;
