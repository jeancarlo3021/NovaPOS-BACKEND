import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * APARTADOS.
 *
 * El cliente separa mercadería, abona de a poco y la retira cuando termina de
 * pagar. Hasta la entrega NO hay venta: no se factura, no entra al cierre como
 * venta y no se declara. Lo que sí pasa desde el primer día es que la mercadería
 * sale del inventario —está apartada— y que entra plata al negocio.
 *
 * Esa distinción es la razón de que esto no se resuelva con una factura a
 * crédito: una factura a crédito ya ocurrió y hay que declararla; un apartado
 * puede no ocurrir nunca.
 */
const reservations = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const ItemSchema = z.object({
  product_id:   z.string().uuid().optional().nullable(),
  product_name: z.string().min(1),
  quantity:     z.number().positive(),
  unit_price:   z.number().nonnegative(),
});

const CreateSchema = z.object({
  customer_id:    z.string().uuid().optional().nullable(),
  customer_name:  z.string().optional().nullable(),
  customer_phone: z.string().optional().nullable(),
  expires_on:     z.string().optional().nullable(),
  notes:          z.string().optional().nullable(),
  items:          z.array(ItemSchema).min(1),
  /** Abono inicial (la prima). Opcional: se puede apartar sin abonar. */
  deposit:        z.number().nonnegative().optional(),
  deposit_method: z.string().optional(),
  cash_session_id: z.string().uuid().optional().nullable(),
});

const round2 = (n: number) => Math.round(Number(n || 0) * 100) / 100;

/** Consecutivo simple del apartado: AP-000001 por negocio. */
async function nextNumber(tenantId: string): Promise<string> {
  const { data } = await db.from('reservations')
    .select('number').eq('tenant_id', tenantId)
    .order('created_at', { ascending: false }).limit(1);
  const ultimo = String((data ?? [])[0]?.number ?? '');
  const n = parseInt(ultimo.replace(/\D/g, ''), 10);
  return `AP-${String((Number.isFinite(n) ? n : 0) + 1).padStart(6, '0')}`;
}

/**
 * Mueve el stock de los artículos apartados.
 *
 * `signo` -1 al apartar (sale de la venta) y +1 al anular o vencer (vuelve).
 * Los productos que no llevan control de existencias se saltan.
 */
async function moverStock(items: any[], signo: 1 | -1) {
  for (const it of items) {
    if (!it.product_id) continue;
    const { data: p } = await db.from('products')
      .select('stock_quantity, tracks_stock').eq('id', it.product_id).maybeSingle();
    if (!p || (p as any).tracks_stock === false) continue;
    const actual = Number((p as any).stock_quantity ?? 0);
    await db.from('products').update({
      stock_quantity: Math.max(0, actual + signo * Number(it.quantity ?? 0)),
      updated_at: new Date().toISOString(),
    }).eq('id', it.product_id);
  }
}

// GET / — lista de apartados. ?status=open|delivered|cancelled|expired|all
reservations.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = String(c.req.query('status') ?? 'open');

    let q = db.from('reservations').select('*, reservation_items(*)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (status !== 'all') q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    /**
     * Los VENCIDOS se marcan al consultarlos.
     *
     * No hay proceso nocturno: si el apartado venció, la mercadería tiene que
     * volver a la venta el día que alguien mire la lista, no cuando a un cron le
     * toque. Se devuelve el stock una sola vez, al cambiar de estado.
     */
    const hoy = new Date().toISOString().slice(0, 10);
    const vencidos = (data ?? []).filter((r: any) =>
      r.status === 'open' && r.expires_on && String(r.expires_on) < hoy);
    for (const r of vencidos as any[]) {
      await moverStock(r.reservation_items ?? [], 1);
      await db.from('reservations')
        .update({ status: 'expired', updated_at: new Date().toISOString() })
        .eq('id', r.id).eq('tenant_id', tenantId);
      r.status = 'expired';
    }

    return ok(c, status === 'all' ? data ?? [] : (data ?? []).filter((r: any) => r.status === status));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id — un apartado con sus artículos y sus abonos.
reservations.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('reservations')
      .select('*, reservation_items(*)')
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Apartado no encontrado', 404);

    const { data: pagos } = await db.from('reservation_payments')
      .select('*').eq('reservation_id', (data as any).id).order('created_at');
    return ok(c, { ...(data as any), payments: pagos ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST / — aparta la mercadería.
reservations.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = CreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const b = parsed.data;

    const items = b.items.map(it => ({
      ...it, subtotal: round2(it.quantity * it.unit_price),
    }));
    const total = round2(items.reduce((s, it) => s + it.subtotal, 0));
    const deposit = round2(b.deposit ?? 0);
    if (deposit > total) return fail(c, 'El abono no puede ser mayor que el total del apartado', 422);

    const { data: res, error } = await db.from('reservations').insert({
      tenant_id: tenantId,
      number: await nextNumber(tenantId),
      customer_id: b.customer_id ?? null,
      customer_name: b.customer_name ?? null,
      customer_phone: b.customer_phone ?? null,
      expires_on: b.expires_on || null,
      notes: b.notes ?? null,
      total, paid: deposit,
      created_by: c.get('userId'),
    }).select('*').single();
    if (error) throw new Error(error.message);

    const rid = (res as any).id;
    const { error: itErr } = await db.from('reservation_items')
      .insert(items.map(it => ({ ...it, reservation_id: rid })));
    if (itErr) throw new Error(itErr.message);

    if (deposit > 0) {
      await db.from('reservation_payments').insert({
        reservation_id: rid, tenant_id: tenantId, amount: deposit,
        method: b.deposit_method ?? 'cash',
        cash_session_id: b.cash_session_id ?? null,
        created_by: c.get('userId'), notes: 'Abono inicial',
      });
    }

    // La mercadería queda apartada: sale del inventario disponible.
    await moverStock(items, -1);

    return ok(c, { ...(res as any), items }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/payments — registra un abono.
reservations.post('/:id/payments', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({} as any));
    const amount = round2(Number(b?.amount ?? 0));
    if (!(amount > 0)) return fail(c, 'El abono tiene que ser mayor que cero', 422);

    const { data: r } = await db.from('reservations')
      .select('id, status, total, paid').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!r) return fail(c, 'Apartado no encontrado', 404);
    if ((r as any).status !== 'open') return fail(c, 'Este apartado ya no está vigente', 409);

    const saldo = round2(Number((r as any).total) - Number((r as any).paid));
    if (amount > saldo) {
      return fail(c, `El abono supera el saldo pendiente (${saldo}). Cobrá el saldo exacto o entregá el apartado.`, 422);
    }

    await db.from('reservation_payments').insert({
      reservation_id: id, tenant_id: tenantId, amount,
      method: b?.method ?? 'cash',
      cash_session_id: b?.cash_session_id ?? null,
      notes: b?.notes ?? null, created_by: c.get('userId'),
    });

    const { data: upd, error } = await db.from('reservations')
      .update({ paid: round2(Number((r as any).paid) + amount), updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, upd, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/cancel — anula el apartado y devuelve la mercadería a la venta.
reservations.post('/:id/cancel', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const { data: r } = await db.from('reservations')
      .select('*, reservation_items(*)').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!r) return fail(c, 'Apartado no encontrado', 404);
    if ((r as any).status !== 'open') return fail(c, 'Este apartado ya no está vigente', 409);

    await moverStock((r as any).reservation_items ?? [], 1);
    const { data, error } = await db.from('reservations').update({
      status: 'cancelled',
      notes: [(r as any).notes, c.req.query('reason')].filter(Boolean).join(' · ') || null,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);

    /**
     * OJO con lo abonado.
     *
     * Anular NO devuelve la plata sola: qué se hace con los abonos —se devuelve,
     * queda a favor, se cobra una penalidad— lo decide el negocio y varía en cada
     * uno. Se informa cuánto hay para que nadie se olvide de resolverlo.
     */
    return ok(c, { ...(data as any), refund_pending: Number((r as any).paid ?? 0) });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id/to-cart — devuelve el apartado listo para cobrar en el POS.
//
// La entrega se factura por el camino normal del punto de venta: así el
// comprobante, el consecutivo, la caja y Hacienda funcionan igual que en
// cualquier venta, sin una segunda vía de facturación que mantener.
reservations.get('/:id/to-cart', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data: r } = await db.from('reservations')
      .select('*, reservation_items(*)').eq('id', c.req.param('id')).eq('tenant_id', tenantId).maybeSingle();
    if (!r) return fail(c, 'Apartado no encontrado', 404);
    if ((r as any).status !== 'open') return fail(c, 'Este apartado ya no está vigente', 409);

    return ok(c, {
      reservation_id: (r as any).id,
      number: (r as any).number,
      customer_id: (r as any).customer_id,
      customer_name: (r as any).customer_name,
      total: Number((r as any).total ?? 0),
      paid: Number((r as any).paid ?? 0),
      balance: round2(Number((r as any).total ?? 0) - Number((r as any).paid ?? 0)),
      items: ((r as any).reservation_items ?? []).map((it: any) => ({
        product_id: it.product_id, product_name: it.product_name,
        quantity: Number(it.quantity), unit_price: Number(it.unit_price),
        subtotal: Number(it.subtotal),
      })),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/deliver — marca el apartado como entregado y lo liga a su factura.
reservations.post('/:id/deliver', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({} as any));

    const { data: r } = await db.from('reservations')
      .select('id, status').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!r) return fail(c, 'Apartado no encontrado', 404);
    if ((r as any).status !== 'open') return fail(c, 'Este apartado ya no está vigente', 409);

    const { data, error } = await db.from('reservations').update({
      status: 'delivered',
      invoice_id: b?.invoice_id ?? null,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    // El stock NO se toca: salió del inventario al apartarse. Descontarlo otra
    // vez al facturar dejaría existencias negativas.
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default reservations;
