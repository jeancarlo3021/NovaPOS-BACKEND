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

    /**
     * EL NOMBRE DEL PRODUCTO DE CADA LÍNEA.
     *
     * `purchase_items` guarda solo `product_id`, y esta respuesta salía con
     * `select('*')`: sin el nombre. El resultado era que TODAS las líneas de una
     * orden se leían «Producto» —el texto de respaldo del front—, tanto al
     * recibir la mercadería como en la orden impresa que se le manda al
     * proveedor. Una orden de compra donde no se sabe qué se está pidiendo no
     * sirve para nada.
     *
     * Se resuelve con UNA consulta a `products` por los ids de las líneas, y se
     * devuelve de las dos formas que el front ya busca: `product.name` y
     * `product_name`.
     */
    const filas = (purchaseItems ?? []) as any[];
    try {
      const ids = [...new Set(filas.map(it => it.product_id).filter(Boolean))];
      if (ids.length) {
        const { data: prods } = await db.from('products')
          .select('id, name, sku, unit_type_id').in('id', ids);
        const porId = new Map(((prods ?? []) as any[]).map(p => [p.id, p]));
        for (const it of filas) {
          const p: any = porId.get(it.product_id);
          /* El producto puede haber sido BORRADO después de la compra: en ese
             caso se dice eso, que es información, y no «Producto» a secas. */
          it.product = p ? { id: p.id, name: p.name, sku: p.sku } : null;
          it.product_name = p?.name ?? p?.sku ?? '(producto eliminado)';
        }
      }
    } catch (e: any) {
      console.warn('[purchases] no se pudieron resolver los nombres:', e?.message);
    }

    return ok(c, {
      ...purchase,
      suppliers: supplier ? { name: supplier.name } : null,
      supplier: supplier ? { name: supplier.name } : null,
      purchase_items: filas,
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
 * SUMA al inventario las cantidades de una compra.
 *
 * Vive aparte de `aplicarRecepcion` porque hay dos momentos que suman lo mismo:
 * recibir la orden, y volver a cargarla cuando el inventario se perdió (un
 * «poner existencias en cero», una restauración, una recepción que se quedó a
 * medias). Lo único que cambia es el motivo que queda escrito en el historial,
 * para que después se pueda distinguir una cosa de la otra.
 *
 * Cada incremento queda en `stock_adjustments`: sin esa línea, nadie puede
 * reconstruir después de dónde salió una existencia.
 */
async function sumarAlStock(params: {
  tenantId: string;
  userId?: string | null;
  purchaseId: string;
  numero: string;
  proveedor?: string | null;
  items: Array<{ product_id: string; quantity: number }>;
  motivo: 'recepcion' | 'recarga';
}): Promise<{ aplicados: number; sinStock: number; fallaron: number; unidades: number }> {
  const { tenantId, userId, purchaseId, numero, proveedor, items, motivo } = params;

  // Precio pagado por unidad, tomado de la COMPRA y no del body: quien llama
  // manda solo producto y cantidad, y el costo tiene que salir de lo que
  // quedó registrado.
  const costByProduct = new Map<string, number>();
  try {
    const { data: pItems } = await db.from('purchase_items')
      .select('product_id, unit_price').eq('purchase_id', purchaseId);
    for (const pi of (pItems ?? []) as any[]) {
      const v = Number(pi.unit_price) || 0;
      if (pi.product_id && v > 0) costByProduct.set(String(pi.product_id), v);
    }
  } catch (e: any) {
    console.warn('[STOCK] no se pudo leer el costo de la compra:', e?.message);
  }

  let aplicados = 0, sinStock = 0, fallaron = 0, unidades = 0;

  for (const item of (items ?? [])) {
    const qty = Number(item.quantity ?? 0);
    if (!qty || qty <= 0) continue;

    const { data: prod } = await db.from('products')
      .select('stock_quantity, tracks_stock, name')
      .eq('id', item.product_id)
      .single();
    if (!prod) { fallaron++; continue; }

    // Producto sin control de stock → no se toca ni se loguea.
    if ((prod as any).tracks_stock === false) { sinStock++; continue; }

    const stockBefore = Number((prod as any).stock_quantity ?? 0);
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
      console.error(`[STOCK] ERROR updating stock for ${item.product_id}:`, upErr.message);
      fallaron++;
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
      reason: (motivo === 'recarga' ? `Recarga de compra ${numero}` : `Compra ${numero}`).trim(),
      notes: motivo === 'recarga'
        ? `Se volvió a cargar la orden${proveedor ? ` de ${proveedor}` : ''}`
        : (proveedor ? `Recepción de ${proveedor}` : 'Recepción de compra'),
    });
    if (adjErr) console.error(`[STOCK] ERROR logging stock_adjustment for ${item.product_id}:`, adjErr.message);

    aplicados++;
    unidades += qty;
  }
  return { aplicados, sinStock, fallaron, unidades };
}

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
  if (canUpdateStock) {
    const r = await sumarAlStock({
      tenantId, userId, purchaseId: id,
      numero: purchase.purchase_number ?? '',
      proveedor: supplier?.name ?? null,
      items: items ?? [],
      motivo: 'recepcion',
    });
    console.log(`[RECEIVE] Stock incremented for ${r.aplicados} items, ${r.sinStock} skipped (tracks_stock=false)`);
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

    /**
     * UNA orden se recibe UNA vez.
     *
     * Sin este freno, cada reintento volvía a sumar: una recepción lenta que el
     * cajero tocó dos veces —o que la cola de pendientes reenvió al volver la
     * señal— entraba tres veces al inventario, y nadie lo nota hasta que el
     * conteo físico no cuadra. Para volver a cargarla a propósito está
     * `/:id/reload-stock`, que lo dice y lo deja escrito como recarga.
     */
    const { data: previa } = await db.from('purchases')
      .select('status, purchase_number').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if ((previa as any)?.status === 'received') {
      return fail(c, `La orden ${(previa as any).purchase_number ?? ''} ya estaba recibida: `
        + 'no se vuelve a sumar sola. Si el inventario se perdió, usá «Cargar al inventario».', 409);
    }
    if ((previa as any)?.status === 'cancelled') {
      return fail(c, 'La orden está cancelada: no se puede recibir.', 409);
    }

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

/**
 * GET /:id/stock-status — ¿qué pasaría si cargo esta orden al inventario?
 *
 * Se mira ANTES de tocar nada: cuánto subiría cada producto, qué hay hoy, y
 * —sobre todo— si esta orden ya se cargó antes. Cargar dos veces una compra no
 * avisa: el sistema queda con el doble de existencias y el error aparece
 * semanas después, en un conteo.
 */
purchases.get('/:id/stock-status', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data: compra } = await db.from('purchases')
      .select('id, purchase_number, status, purchase_date, total_amount, supplier_id')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!compra) return fail(c, 'Orden no encontrada', 404);
    const p: any = compra;

    const { data: items } = await db.from('purchase_items')
      .select('product_id, quantity, unit_price').eq('purchase_id', id);
    const lineas = (items ?? []) as any[];

    const ids = [...new Set(lineas.map(l => String(l.product_id)).filter(Boolean))];
    const { data: prods } = ids.length
      ? await db.from('products').select('id, name, sku, stock_quantity, tracks_stock').in('id', ids)
      : { data: [] as any[] };
    const porId = new Map(((prods ?? []) as any[]).map(x => [String(x.id), x]));

    /* Lo que ya se le cargó a esta orden, según el historial. Es la única
       prueba de si el inventario ya entró: el estado «recibida» no lo dice
       —una recepción puede haberse marcado sin tocar existencias—. */
    const numero = String(p.purchase_number ?? '').trim();
    const { data: ajustes } = await db.from('stock_adjustments')
      .select('product_id, quantity, created_at, reason')
      .eq('tenant_id', tenantId)
      .in('reason', [`Compra ${numero}`, `Recarga de compra ${numero}`])
      .order('created_at').limit(5000);
    const hist = (ajustes ?? []) as any[];
    const cargas = [...new Set(hist.map(a => String(a.created_at).slice(0, 16)))];

    // Cuántas líneas caen sobre el mismo producto: con la factura electrónica
    // mal conciliada, decenas de artículos distintos terminan en uno solo.
    const porProducto = new Map<string, { nombre: string; sku: string | null; lineas: number; cantidad: number; stock: number | null; infinito: boolean }>();
    for (const l of lineas) {
      const pid = String(l.product_id ?? '');
      const prod: any = porId.get(pid);
      const e = porProducto.get(pid) ?? {
        nombre: prod?.name ?? '(producto eliminado)',
        sku: prod?.sku ?? null,
        lineas: 0, cantidad: 0,
        stock: prod ? Number(prod.stock_quantity ?? 0) : null,
        infinito: prod?.tracks_stock === false,
      };
      e.lineas += 1;
      e.cantidad += Number(l.quantity ?? 0);
      porProducto.set(pid, e);
    }
    const detalle = [...porProducto.entries()]
      .map(([product_id, v]) => ({ product_id, ...v }))
      .sort((a, b) => b.lineas - a.lineas);

    const repetidos = detalle.filter(d => d.lineas > 1);
    return ok(c, {
      purchase_number: p.purchase_number,
      status: p.status,
      purchase_date: p.purchase_date,
      lineas: lineas.length,
      productos: detalle.length,
      unidades: lineas.reduce((s2, l) => s2 + Number(l.quantity ?? 0), 0),
      /** Veces que esta orden ya entró al inventario, con su fecha. */
      cargas_previas: cargas,
      unidades_ya_cargadas: hist.reduce((s2, a) => s2 + Number(a.quantity ?? 0), 0),
      /* Señal de orden mal conciliada: muchas líneas sobre un mismo producto.
         Cargarla así no arregla el inventario, lo empeora. */
      lineas_repetidas: repetidos.reduce((s2, d) => s2 + d.lineas, 0),
      sospechosa: repetidos.some(d => d.lineas >= 5),
      detalle,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * POST /:id/reload-stock — vuelve a cargar la orden al inventario.
 *
 * Para cuando la mercadería SÍ entró pero las existencias no están: se puso el
 * inventario en cero, se restauró un respaldo viejo, o la recepción se cortó a
 * la mitad. No cambia el estado de la orden ni vuelve a crear la cuenta por
 * pagar —la plata ya se registró—: solo suma existencias y lo deja escrito.
 *
 * Pide `confirmar: true` a propósito. Es la clase de operación que no se debe
 * poder disparar con un toque de más.
 */
purchases.post('/:id/reload-stock', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({})) as { confirmar?: boolean };
    if (body?.confirmar !== true) {
      return fail(c, 'Falta confirmar la recarga.', 422);
    }

    const { data: compra } = await db.from('purchases')
      .select('id, purchase_number, status, supplier_id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!compra) return fail(c, 'Orden no encontrada', 404);
    const p: any = compra;
    if (p.status === 'cancelled') {
      return fail(c, 'La orden está cancelada: no se carga al inventario.', 409);
    }

    const { data: items } = await db.from('purchase_items')
      .select('product_id, quantity').eq('purchase_id', id);
    const lineas = ((items ?? []) as any[]).filter(l => l.product_id);
    if (lineas.length === 0) {
      return fail(c, 'La orden no tiene artículos que cargar.', 409);
    }

    const { data: prov } = p.supplier_id
      ? await db.from('suppliers').select('name').eq('id', p.supplier_id).maybeSingle()
      : { data: null };

    const r = await sumarAlStock({
      tenantId, userId: c.get('userId'), purchaseId: id,
      numero: String(p.purchase_number ?? ''),
      proveedor: (prov as any)?.name ?? null,
      items: lineas.map(l => ({ product_id: String(l.product_id), quantity: Number(l.quantity) })),
      motivo: 'recarga',
    });

    /* Una orden que estaba pendiente y se carga a mano queda recibida: dejarla
       pendiente con el inventario ya adentro invita a recibirla otra vez. */
    if (p.status !== 'received') {
      await db.from('purchases').update({
        status: 'received',
        actual_delivery_date: new Date().toISOString().slice(0, 10),
        updated_at: new Date().toISOString(),
      }).eq('id', id).eq('tenant_id', tenantId);
    }

    try {
      await db.from('user_activity_log').insert({
        tenant_id: tenantId, user_id: c.get('userId'),
        action: 'compra_recargada_a_inventario',
        details: { orden: p.purchase_number, ...r },
      });
    } catch { /* el registro es deseable, no obligatorio */ }

    return ok(c, { purchase_number: p.purchase_number, ...r });
  } catch (err: any) {
    console.error('[RELOAD-STOCK] ERROR:', err.message);
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
