import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { endOfDay } from '../utils/dateRange.js';
import { createReceivable } from './accountsReceivable.js';
import {
  consumeForInvoice, applyConsumption, snapshotItemCosts, revertConsumption,
} from '../services/recipeConsumption.js';

const invoices = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// CartItem from frontend has extra fields (product, promo) — accept any object with product_id
const ItemSchema = z.object({
  // product_id NULL = producto rápido/ad-hoc (no está en el catálogo). En ese caso
  // el nombre viaja en product_name.
  product_id:       z.string().uuid().nullable().optional(),
  product_name:     z.string().optional().nullable(),
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
  payment_method:   z.enum(['cash', 'card', 'sinpe', 'check', 'transfer', 'third_party', 'digital', 'other', 'credit']).default('cash'),
  /** Tipo de documento fiscal. */
  document_type:    z.enum(['ticket', 'tiquete_electronico', 'factura_electronica']).optional().default('ticket'),
  // Multimoneda: moneda del pago en efectivo y tipo de cambio (₡ por $1).
  currency:         z.enum(['CRC', 'USD']).optional().default('CRC'),
  exchange_rate:    z.number().positive().optional().nullable(),
  change_currency:  z.enum(['CRC', 'USD']).optional().nullable(),
  status:           z.enum(['draft', 'completed', 'cancelled']).default('completed'),
  // Delivery: la venta NO se suma al cierre de caja; se contabiliza aparte. Se le
  // puede restar una comisión (%) para saber el neto recibido.
  is_delivery:              z.boolean().optional().default(false),
  delivery_commission_pct:  z.number().nonnegative().max(100).optional().default(0),
  delivery_net:             z.number().optional().nullable(),
  delivery_platform:        z.string().optional().nullable(),
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

// Genera el próximo número de factura ÚNICO por tenant: consecutivo simple
// 000001, 000002, ... — el mismo para ventas online y offline. Toma el MAYOR
// número de secuencia ya usado por el tenant (los dígitos finales de cualquier
// formato) y le suma 1. `attemptOffset` permite reintentar ante colisión.
export async function nextInvoiceNumber(tenantId: string, attemptOffset = 0, floor = 0): Promise<string> {
  // ⚠️ Paginado: Supabase trae máx 1000 filas por query. Con miles de facturas,
  // sin paginar/ordenar el máximo salía MÁS BAJO que el real → número DUPLICADO.
  // Solo consecutivos SIMPLES (1-6 dígitos puros); se ignoran fechas/claves de FE.
  const PAGE = 1000;
  let maxSeq = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('invoices')
      .select('invoice_number').eq('tenant_id', tenantId)
      .order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) break;
    const chunk = (data ?? []) as any[];
    for (const r of chunk) {
      const s = String(r.invoice_number ?? '').trim();
      if (/^\d{1,10}$/.test(s)) maxSeq = Math.max(maxSeq, parseInt(s, 10));
    }
    if (chunk.length < PAGE) break;
  }
  // `floor` = consecutivo inicial configurado en Datos de FE (numeración migrada):
  // el próximo número nunca es menor que ese piso.
  return String(Math.max(maxSeq + 1, floor) + attemptOffset).padStart(6, '0');
}

/** Piso de consecutivo migrado: el MAYOR de los "Próx. …" configurados en
 *  Datos de FE (se comparte un solo contador entre corriente y electrónico). */
export async function consecutivoFloor(tenantId: string): Promise<number> {
  try {
    const { data } = await db.from('settings').select('config')
      .eq('tenant_id', tenantId).eq('type', 'electronic-invoice').maybeSingle();
    const cfg: any = (data as any)?.config ?? {};
    const nums = [cfg.consecutivo_factura, cfg.consecutivo_tiquete, cfg.consecutivo_nc]
      .map(v => parseInt(String(v ?? '').replace(/\D/g, ''), 10))
      .filter(n => Number.isFinite(n) && n > 0);
    return nums.length ? Math.max(...nums) : 0;
  } catch { return 0; }
}

invoices.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from  = c.req.query('from');
    const to    = endOfDay(c.req.query('to'));
    const cashSessionId = c.req.query('cash_session_id');
    const page  = Number(c.req.query('page') ?? 1);
    const limit = Number(c.req.query('limit') ?? 50);

    let query = db.from('invoices').select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('issued_at', { ascending: false });

    // Filtro por sesión de caja (usado por el cierre de caja). Cuando viene,
    // devolvemos TODAS las facturas de la sesión sin paginar.
    if (cashSessionId) {
      query = query.eq('cash_session_id', cashSessionId);
    } else {
      query = query.range((page - 1) * limit, page * limit - 1);
    }
    if (from) query = query.gte('issued_at', from);
    if (to)   query = query.lte('issued_at', to);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    return ok(c, { invoices: data, total: count, page, limit });
  } catch (err: any) { return fail(c, err.message, 500); }
});

invoices.get('/next-number', async (c) => {
  try {
    const tid = c.get('tenantId');
    const num = await nextInvoiceNumber(tid, 0, await consecutivoFloor(tid));
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

    // ── Sesión de caja: tiene que EXISTIR ────────────────────────────────────
    // Una venta hecha sin conexión se guarda con el id LOCAL de la caja que se
    // abrió offline. Si al sincronizar ese id no se remapeó al de verdad (otro
    // dispositivo, cache limpiado, la sesión se sincronizó después), la factura
    // entraba igual —el id es un uuid válido— pero apuntando a una sesión que no
    // existe: la venta quedaba en la base y el CIERRE DE CAJA daba 0.
    //
    // Acá se comprueba y, si no existe, se reengancha a la caja abierta del
    // cajero. Es preferible que la venta aparezca en el cierre de hoy a que
    // desaparezca del arqueo para siempre.
    let sessionWarning: string | null = null;
    if (invoiceData.cash_session_id) {
      const check = await db.from('cash_sessions')
        .select('id').eq('id', invoiceData.cash_session_id).eq('tenant_id', tenantId).maybeSingle();

      // Si la CONSULTA falla (no es que la sesión no exista, es que no se pudo
      // preguntar), se deja la venta como venía. Mover ventas de caja por un
      // error de lectura sería peor que el problema que esto arregla.
      if (check.error) {
        console.warn('[invoices] no se pudo verificar la caja:', check.error.message);
      } else if (!check.data) {
        // La sesión NO existe. Se reengancha SOLO a la caja abierta de este mismo
        // cajero: mandarla a "cualquier caja abierta" metería las ventas en el
        // arqueo de otro compañero, que es justo lo que nadie puede cuadrar.
        const ownerId = attributedCashierId ?? callerUserId ?? null;
        const own = ownerId
          ? await db.from('cash_sessions')
              .select('id').eq('tenant_id', tenantId).eq('status', 'open').eq('user_id', ownerId)
              .order('opening_date', { ascending: false }).limit(1).maybeSingle()
          : { data: null, error: null };

        if ((own as any)?.data?.id) {
          sessionWarning = `La caja de la venta offline (${invoiceData.cash_session_id}) ya no existe: se registró en tu caja abierta.`;
          console.warn('[invoices]', sessionWarning);
          invoiceData.cash_session_id = (own as any).data.id;
        } else {
          // Sin caja abierta propia: se rechaza para que la venta SIGA en la cola
          // del dispositivo y se sincronice cuando abran caja, en vez de quedar
          // huérfana y no aparecer en ningún cierre.
          return fail(c,
            'La caja de esta venta no existe y no tenés ninguna caja abierta. '
            + 'Abrí la caja y volvé a sincronizar para que la venta entre en el arqueo.', 409);
        }
      }
    }

    // Insert con reintento ante colisión de número (unique tenant_id+invoice_number).
    // Puede chocar si: 2 ventas casi simultáneas, o una venta offline trae un
    // número que ya existe online. Reintentamos regenerando el consecutivo.
    let inv: any = null;
    let invErr: any = null;
    // Consecutivo unificado: el backend SIEMPRE asigna el número (ignora el que
    // venga del cliente) para que online y offline compartan una sola secuencia.
    void invoice_number;
    const floor = await consecutivoFloor(tenantId);
    let finalNumber = await nextInvoiceNumber(tenantId, 0, floor);

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
      finalNumber = await nextInvoiceNumber(tenantId, attempt + 1, floor);
    }
    if (invErr) throw new Error(invErr.message);
    if (!inv) throw new Error('No se pudo generar la factura (número duplicado)');

    // Cliente excluido del cierre (ej. compras de empleados): marcamos la factura para
    // que el cierre de caja NO la contabilice. Best-effort (update aparte) para no
    // romper la creación si la columna/ migración 71 aún no está.
    if (invoiceData.customer_id) {
      try {
        const { data: cust } = await db.from('customers')
          .select('exclude_from_cash_close').eq('id', invoiceData.customer_id).eq('tenant_id', tenantId).maybeSingle();
        if ((cust as any)?.exclude_from_cash_close) {
          await db.from('invoices').update({ exclude_from_close: true }).eq('id', inv.id).eq('tenant_id', tenantId);
          (inv as any).exclude_from_close = true;
        }
      } catch { /* columna sin migrar → se ignora */ }
    }

    // Insert items (strip extra CartItem fields)
    const itemRows = items.map((item: any) => ({
      invoice_id:       inv.id,
      product_id:       item.product_id ?? null,
      // Nombre del producto (snapshot). Imprescindible para los ad-hoc que no tienen
      // product_id con qué resolver el nombre después.
      product_name:     item.product_name ?? item.product?.name ?? null,
      quantity:         item.quantity,
      unit_price:       item.unit_price,
      discount_percent: item.discount_percent ?? 0,
      discount_amount:  item.discount_amount ?? 0,
      subtotal:         item.subtotal,
      // Nota de la línea (comidas: "sin cebolla", "para llevar"…).
      notes:            item.notes?.trim() ? String(item.notes).trim() : null,
    }));
    let { error: itemErr } = await db.from('invoice_items').insert(itemRows);
    // Si la columna product_name aún no existe (migración 70 sin correr), reintentar sin ella.
    if (itemErr && /product_name/i.test(itemErr.message)) {
      const stripped = itemRows.map(({ product_name, ...r }: any) => r);
      ({ error: itemErr } = await db.from('invoice_items').insert(stripped));
    }
    // Idem con `notes` (migración 74 sin correr).
    if (itemErr && /notes/i.test(itemErr.message)) {
      const stripped = itemRows.map(({ notes, ...r }: any) => r);
      ({ error: itemErr } = await db.from('invoice_items').insert(stripped));
    }
    if (itemErr) throw new Error(itemErr.message);

    // ── Recetas: consumo de ingredientes ────────────────────────────────────
    // Vender un plato con receta descuenta sus INGREDIENTES, no el plato. Se
    // resuelve ANTES del descuento normal para saber qué productos ya quedaron
    // cubiertos por su receta y no descontarlos dos veces.
    //
    // Todo esto queda inerte si el plan no trae `recipe_consumption`, y un fallo
    // acá no puede tumbar la venta: el cliente ya pagó y la factura ya existe.
    let recipeProductIds = new Set<string>();
    let costByProduct = new Map<string, number>();
    try {
      const r = await consumeForInvoice(tenantId, inv.id, items as any[]);
      recipeProductIds = r.recipeProductIds;
      costByProduct = r.costByProduct;
      if (r.lines.length) {
        await applyConsumption(tenantId, r.lines, { invoice_id: inv.id });
      }
    } catch (e: any) {
      console.warn('[recipes] no se pudo aplicar el consumo:', e?.message);
    }

    // Vender un KIT descuenta sus componentes, no el kit. Mismo criterio que
    // las recetas, y también sin poder tumbar la venta si algo falla.
    const kitProductIds = new Set<string>();
    try {
      const ids = (items as any[]).map(i => i.product_id).filter(Boolean);
      if (ids.length) {
        const { data: kitRows } = await db.from('product_kit_items')
          .select('kit_id, component_id, quantity')
          .eq('tenant_id', tenantId).in('kit_id', ids);
        if (kitRows?.length) {
          // Cuánto hay que bajar de cada componente, sumando kits repetidos.
          const need = new Map<string, number>();
          for (const item of items as any[]) {
            for (const k of (kitRows as any[]).filter(r => String(r.kit_id) === String(item.product_id))) {
              kitProductIds.add(String(item.product_id));
              const q = Number(k.quantity) * Number(item.quantity);
              need.set(String(k.component_id), (need.get(String(k.component_id)) ?? 0) + q);
            }
          }
          for (const [componentId, qty] of need) {
            const { data: p } = await db.from('products')
              .select('stock_quantity, tracks_stock').eq('id', componentId).maybeSingle();
            if (p && (p as any).tracks_stock !== false) {
              await db.from('products').update({
                stock_quantity: Math.max(0, (p.stock_quantity ?? 0) - qty),
                updated_at: new Date().toISOString(),
              }).eq('id', componentId);
            }
          }
        }
      }
    } catch (e: any) { console.warn('[kits] no se pudo descontar componentes:', e?.message); }

    // Decrement stock — SOLO productos que manejan inventario.
    // Los de stock infinito (tracks_stock === false) NO se descuentan.
    for (const item of items as any[]) {
      if (!item.product_id) continue;   // ad-hoc: sin producto que descontar
      // El kit ya movió inventario por sus componentes.
      if (kitProductIds.has(String(item.product_id))) continue;
      // Con receta, el inventario ya se movió por ingredientes: descontar además
      // el plato sería contarlo dos veces.
      if (recipeProductIds.has(item.product_id)) continue;
      const { data: p } = await db.from('products')
        .select('stock_quantity, tracks_stock').eq('id', item.product_id).maybeSingle();
      if (p && (p as any).tracks_stock !== false) {
        await db.from('products').update({
          stock_quantity: Math.max(0, (p.stock_quantity ?? 0) - Number(item.quantity)),
          updated_at: new Date().toISOString(),
        }).eq('id', item.product_id);
      }
    }

    // ── Costo CONGELADO de la venta ─────────────────────────────────────────
    // El costo se recalculaba siempre con el `cost_price` de hoy, así que una
    // venta vieja se recosteaba con el precio actual y el food cost histórico
    // era ficción. Se guarda ahora o no se puede reconstruir nunca.
    try { await snapshotItemCosts(tenantId, inv.id, items as any[], costByProduct); }
    catch (e: any) { console.warn('[recipes] no se pudo congelar el costo:', e?.message); }

    // Venta a CRÉDITO → generar la cuenta por cobrar (vence en 30 días).
    if (inv.payment_method === 'credit') {
      try {
        const due = new Date(); due.setDate(due.getDate() + 30);
        await createReceivable(tenantId, {
          customer_id: inv.customer_id ?? null,
          customer_name: inv.customer_name ?? null,
          invoice_id: inv.id, invoice_number: inv.invoice_number,
          total_amount: Number(inv.total ?? 0),
          due_date: due.toISOString().slice(0, 10),
          source: 'pos',
        });
      } catch (e: any) { console.warn('[invoices] crear CxC:', e?.message); }
    }

    return ok(c, sessionWarning ? { ...(inv as any), session_warning: sessionWarning } : inv, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/to-credit — ANULAR EL PAGO de una factura pagada y dejarla A CRÉDITO
// (con saldo pendiente en Cuentas por Cobrar), SIN anular la factura.
// Solo administrador, gerente, contador o dueño.
const TO_CREDIT_ROLES = new Set(['owner', 'admin', 'gerente', 'contador']);
invoices.post('/:id/to-credit', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!TO_CREDIT_ROLES.has(String(c.get('role') ?? ''))) {
      return fail(c, 'Solo el administrador, gerente o contador pueden anular el pago.', 403);
    }
    const { id } = c.req.param();
    const { data: inv } = await db.from('invoices')
      .select('id, status, total, payment_method, cash_session_id, customer_id, customer_name, invoice_number')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    if ((inv as any).status !== 'completed') return fail(c, 'Solo se puede en facturas completadas', 409);
    if ((inv as any).payment_method === 'credit') return fail(c, 'La factura ya está a crédito', 409);

    const { data: existing } = await db.from('accounts_receivable')
      .select('id').eq('invoice_id', id).eq('tenant_id', tenantId).maybeSingle();
    if (existing) return fail(c, 'La factura ya tiene una cuenta por cobrar', 409);

    const due = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await createReceivable(tenantId, {
      customer_id: (inv as any).customer_id, customer_name: (inv as any).customer_name,
      invoice_id: id, invoice_number: (inv as any).invoice_number,
      total_amount: Number((inv as any).total ?? 0), due_date: due, source: 'pos',
      notes: 'Pago anulado — pasado a crédito',
    });
    await db.from('invoices')
      .update({ payment_method: 'credit', updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId);
    // Revertir el ingreso de caja (la venta había sumado; ahora queda a crédito).
    if ((inv as any).cash_session_id) {
      try {
        await db.from('cash_movements').insert({
          cash_session_id: (inv as any).cash_session_id, type: 'out',
          amount: Number((inv as any).total ?? 0),
          description: `Pago anulado (a crédito) factura ${(inv as any).invoice_number}`,
          reference_id: id,
        });
      } catch (e) { console.warn('[to-credit] caja:', e); }
    }
    return ok(c, { ok: true, to_credit: true, total: Number((inv as any).total ?? 0) });
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
    //
    //    Si la venta consumió ingredientes por receta, lo que hay que devolver
    //    son los INGREDIENTES, no el plato: el plato nunca se descontó. Los
    //    productos así devueltos se excluyen del bucle de abajo.
    const recipeReturned = new Set<string>();
    try {
      const { data: cons } = await db.from('recipe_consumptions')
        .select('product_id').eq('tenant_id', tenantId).eq('invoice_id', id).is('reverted_at', null);
      if (cons?.length) {
        await revertConsumption(tenantId, id);
        // El plato en sí no se descontó al vender, así que tampoco se devuelve.
        const { data: sold } = await db.from('invoice_items')
          .select('product_id').eq('invoice_id', id);
        const { data: recs } = await db.from('recipes')
          .select('product_id').eq('tenant_id', tenantId).not('product_id', 'is', null);
        const withRecipe = new Set((recs ?? []).map((r: any) => String(r.product_id)));
        for (const s of (sold ?? []) as any[]) {
          if (s.product_id && withRecipe.has(String(s.product_id))) recipeReturned.add(String(s.product_id));
        }
      }
    } catch (e: any) { console.warn('[void] consumo de recetas:', e?.message); }

    const { data: items } = await db.from('invoice_items')
      .select('product_id, quantity').eq('invoice_id', id);

    // Los kits devuelven sus COMPONENTES: el kit nunca se descontó.
    const kitReturned = new Set<string>();
    try {
      const ids = (items ?? []).map((i: any) => i.product_id).filter(Boolean);
      if (ids.length) {
        const { data: kitRows } = await db.from('product_kit_items')
          .select('kit_id, component_id, quantity')
          .eq('tenant_id', tenantId).in('kit_id', ids);
        if (kitRows?.length) {
          const back = new Map<string, number>();
          for (const it of (items ?? []) as any[]) {
            for (const k of (kitRows as any[]).filter(r => String(r.kit_id) === String(it.product_id))) {
              kitReturned.add(String(it.product_id));
              const q = Number(k.quantity) * Number(it.quantity);
              back.set(String(k.component_id), (back.get(String(k.component_id)) ?? 0) + q);
            }
          }
          for (const [componentId, qty] of back) {
            const { data: p } = await db.from('products')
              .select('stock_quantity, tracks_stock').eq('id', componentId).maybeSingle();
            if (p && (p as any).tracks_stock !== false) {
              await db.from('products').update({
                stock_quantity: (p.stock_quantity ?? 0) + qty,
                updated_at: new Date().toISOString(),
              }).eq('id', componentId);
            }
          }
        }
      }
    } catch (e: any) { console.warn('[kits] no se pudo devolver componentes:', e?.message); }

    // Venta de RUTA: el stock salió del camión, no de la bodega. Devolverlo a
    // `products` inflaría el inventario general y dejaría el camión corto.
    let truckId: string | null = null;
    if ((data as any).route_id) {
      const { data: route } = await db.from('routes')
        .select('warehouse_id').eq('id', (data as any).route_id).eq('tenant_id', tenantId).maybeSingle();
      truckId = (route as any)?.warehouse_id ?? null;
    }

    let restocked = 0;
    const skipped: string[] = [];
    for (const it of (items ?? []) as any[]) {
      if (!it.product_id) { skipped.push('línea sin producto'); continue; }
      if (recipeReturned.has(String(it.product_id))) continue;
      if (kitReturned.has(String(it.product_id))) continue;

      if (truckId) {
        const { data: row } = await db.from('warehouse_stock')
          .select('quantity').eq('warehouse_id', truckId).eq('product_id', it.product_id).maybeSingle();
        const up = await db.from('warehouse_stock').upsert({
          warehouse_id: truckId, product_id: it.product_id,
          quantity: Number((row as any)?.quantity ?? 0) + Number(it.quantity),
        }, { onConflict: 'warehouse_id,product_id' });
        if (up.error) { console.warn('[void] camión:', up.error.message); skipped.push(String(it.product_id)); }
        else restocked++;
        continue;
      }

      const { data: p, error: readP } = await db.from('products')
        .select('stock_quantity, tracks_stock').eq('id', it.product_id).eq('tenant_id', tenantId).maybeSingle();
      if (readP) { console.warn('[void] no se pudo leer el producto:', readP.message); skipped.push(String(it.product_id)); continue; }
      // Producto borrado o de stock infinito: no hay nada que devolver.
      if (!p) { skipped.push(String(it.product_id)); continue; }
      if ((p as any).tracks_stock === false) continue;

      const upd = await db.from('products').update({
        stock_quantity: Number((p as any).stock_quantity ?? 0) + Number(it.quantity),
        updated_at: new Date().toISOString(),
      }).eq('id', it.product_id).eq('tenant_id', tenantId);
      if (upd.error) { console.warn('[void] no se pudo devolver stock:', upd.error.message); skipped.push(String(it.product_id)); }
      else restocked++;
    }
    if (skipped.length) console.warn('[void] líneas sin devolver:', skipped.join(', '));

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

    // 5) Anular la CUENTA POR COBRAR (crédito) de esta factura y sus ABONOS:
    //    al cancelar la factura completa, los abonos quedan anulados y la cuenta
    //    se marca cancelada (deja de contar como saldo pendiente).
    try {
      const { data: ars } = await db.from('accounts_receivable')
        .select('id').eq('tenant_id', tenantId).eq('invoice_id', id);
      const arIds = ((ars ?? []) as any[]).map(r => r.id);
      if (arIds.length) {
        // Marcar abonos como anulados (soft). Fallback si migración 63 sin correr.
        const v = await db.from('accounts_receivable_payments')
          .update({ voided_at: new Date().toISOString() })
          .in('receivable_id', arIds).eq('tenant_id', tenantId).is('voided_at', null);
        if (v.error && !/voided_at|column/.test(v.error.message ?? '')) {
          console.warn('[void] abonos:', v.error.message);
        }
        await db.from('accounts_receivable')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .in('id', arIds).eq('tenant_id', tenantId);
      }
    } catch (e) { console.warn('[void] no se pudo anular la CxC:', e); }

    // El resultado del reintegro viaja con la respuesta: si algo no se pudo
    // devolver, la caja tiene que enterarse en el momento, no al hacer conteo.
    return ok(c, {
      ...(data as any),
      restocked,
      restock_target: truckId ? 'truck' : 'inventory',
      restock_skipped: skipped.length,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default invoices;
