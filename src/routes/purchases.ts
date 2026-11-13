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
   * YA NO SE USA: toda compra nace PENDIENTE.
   *
   * Existió un atajo que creaba y recibía de un saque. Es cómodo y es justo
   * donde se cuelan los errores caros: una línea mal copiada de la factura ya
   * movió existencias y creó una cuenta por pagar antes de que nadie la
   * mirara, y deshacer eso cuesta mucho más que el paso que ahorraba.
   *
   * El campo se sigue aceptando —sin efecto— porque la cola de compras
   * offline puede tener pedidos viejos guardados con `receive_now: true`, y
   * rechazarlos al sincronizar haría perder una compra ya tecleada. Entran
   * como pendientes, que es lo que corresponde.
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

    const { items, receive_now: _yaNoSeUsa, canUpdateStock: _tampoco, ...purchaseData } = parsed.data;

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

    /* La compra NO se recibe acá, aunque lo pidan: la mercadería entra por
       «Revisar y Recibir», donde se confirman cantidades y precios línea por
       línea antes de tocar el inventario. */
    return ok(c, purchase, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

const EdicionSchema = z.object({
  supplier_id:            z.string().uuid().optional(),
  purchase_date:          z.string().optional(),
  expected_delivery_date: z.string().optional().nullable(),
  notes:                  z.string().optional().nullable(),
  /** Las líneas COMPLETAS: lo que no venga en la lista deja de estar. */
  items:                  z.array(ItemSchema).optional(),
  /** Solo para cancelar. Recibir va por `/receive`, que mueve inventario. */
  status:                 z.enum(['pending', 'cancelled']).optional(),
});

/**
 * PUT /:id — CORREGIR UNA ORDEN DE COMPRA.
 *
 * Hasta ahora una orden mal armada no tenía arreglo: se cancelaba y se hacía
 * de nuevo. Con veinte líneas copiadas de una factura, eso es media hora de
 * trabajo tirada por un precio mal tecleado, así que lo que pasaba de verdad
 * era que se recibía mal y el costo quedaba sucio para siempre.
 *
 * ── Dos reglas, y el motivo de cada una ──────────────────────────────────
 *
 * 1. SOLO MIENTRAS ESTÉ PENDIENTE. Una orden recibida ya movió existencias,
 *    costos y —si el proveedor es a crédito— una cuenta por pagar. Cambiarle
 *    las líneas después dejaría el inventario diciendo una cosa y la orden
 *    otra, sin que nadie se entere. Para eso están «Cargar al inventario» y
 *    el ajuste de existencias, que dejan rastro.
 *
 * 2. EL TOTAL LO CALCULA EL SERVIDOR, siempre, desde las líneas. Si el total
 *    viniera del formulario, una orden podría terminar con líneas que suman
 *    ₡90.000 y un total de ₡100.000, y esa diferencia después es una cuenta
 *    por pagar equivocada.
 *
 * El campo `status` acá solo sirve para CANCELAR: recibir mueve inventario y
 * crea cuentas por pagar, así que tiene su propio camino.
 */
purchases.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const parsed = EdicionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, 'Datos inválidos para editar la orden', 422);
    const { items, ...cabeza } = parsed.data;

    const { data: previa } = await db.from('purchases')
      .select('status, purchase_number').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!previa) return fail(c, 'Orden de compra no encontrada', 404);

    const estado = String((previa as any).status ?? '');
    const numero = (previa as any).purchase_number ?? '';
    /* Cambiar solo el estado (cancelar) se permite siempre que la orden esté
       pendiente; tocar los datos de una orden ya recibida, no. */
    const tocaDatos = items !== undefined || Object.keys(cabeza).some(k => k !== 'status');
    if (tocaDatos && estado !== 'pending') {
      return fail(c, estado === 'received'
        ? `La orden ${numero} ya se recibió: la mercadería entró al inventario y, si el proveedor es a crédito, `
          + 'ya hay una cuenta por pagar. Cambiarle las líneas ahora dejaría el inventario diciendo otra cosa.'
        : `La orden ${numero} está cancelada: no se puede editar.`, 409);
    }
    if (cabeza.status === 'cancelled' && estado === 'received') {
      return fail(c, `La orden ${numero} ya se recibió: no se puede cancelar.`, 409);
    }

    const patch: Record<string, any> = { ...cabeza, updated_at: new Date().toISOString() };

    if (items !== undefined) {
      if (items.length === 0) return fail(c, 'La orden necesita al menos un artículo', 422);
      /* Se reemplazan todas: emparejar línea por línea obligaría a mandar los
         id de cada una y a adivinar qué hacer con las que no vinieron. */
      const { error: eBorrar } = await db.from('purchase_items').delete().eq('purchase_id', id);
      if (eBorrar) throw new Error(eBorrar.message);
      const filas = items.map(it => ({
        purchase_id: id,
        product_id: it.product_id,
        quantity: it.quantity,
        unit_price: it.unit_price,
        subtotal: Math.round(it.quantity * it.unit_price * 100) / 100,
      }));
      const { error: eItems } = await db.from('purchase_items').insert(filas);
      if (eItems) throw new Error(eItems.message);
      patch.total_amount = Math.round(filas.reduce((s2, f) => s2 + f.subtotal, 0) * 100) / 100;
    }

    const { data, error } = await db.from('purchases')
      .update(patch).eq('id', id).eq('tenant_id', tenantId).select().single();
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
  /** `unit_price` viene cuando el precio de la factura no fue el de la orden. */
  items: Array<{ product_id: string; quantity: number; unit_price?: number }>;
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

  /**
   * LO QUE SE CORRIGIÓ AL REVISAR, SE GUARDA.
   *
   * La pantalla de «Revisar y recibir» deja arreglar cantidades y precios
   * —llegaron 8 de 10, el proveedor subió el precio— y hasta ahora esas
   * correcciones se usaban para sumar el stock y después se tiraban: la orden
   * seguía diciendo 10 al precio viejo, el total no cambiaba, y la cuenta por
   * pagar se creaba por un monto que el proveedor nunca facturó.
   *
   * Acá quedan escritas: `received_quantity` (que existía y nadie llenaba),
   * el precio real, y el total recalculado desde lo que DE VERDAD entró.
   */
  let totalRecibido: number | null = null;
  try {
    const { data: lineas } = await db.from('purchase_items')
      .select('id, product_id, quantity, unit_price').eq('purchase_id', id);
    const recibido = new Map<string, { quantity: number; unit_price?: number }>();
    for (const it of (items ?? [])) {
      if (it?.product_id) recibido.set(String(it.product_id), { quantity: Number(it.quantity) || 0, unit_price: it.unit_price });
    }

    let suma = 0;
    for (const l of ((lineas ?? []) as any[])) {
      const r = recibido.get(String(l.product_id));
      /* Una línea que no vino en la revisión se toma como recibida completa:
         es lo que pasaba antes y cambiarlo en silencio daría por no recibido
         algo que sí llegó. */
      const cantidad = r ? r.quantity : Number(l.quantity) || 0;
      const precio = r?.unit_price != null ? Number(r.unit_price) : Number(l.unit_price) || 0;
      const subtotal = Math.round(cantidad * precio * 100) / 100;
      suma += subtotal;
      if (r && (cantidad !== Number(l.quantity) || precio !== Number(l.unit_price))) {
        await db.from('purchase_items')
          .update({ received_quantity: cantidad, unit_price: precio, subtotal })
          .eq('id', l.id);
      } else if (r) {
        await db.from('purchase_items').update({ received_quantity: cantidad }).eq('id', l.id);
      }
    }
    totalRecibido = Math.round(suma * 100) / 100;
  } catch (e: any) {
    console.warn('[RECEIVE] no se pudieron guardar las correcciones de la revisión:', e?.message);
  }

  // Marcar recibida.
  const { data: updated, error: uErr } = await db.from('purchases')
    .update({
      status: 'received',
      actual_delivery_date: new Date().toISOString().slice(0, 10),
      ...(notes !== undefined ? { notes: notes || null } : {}),
      /* El total pasa a ser el de lo que entró, no el de lo que se pidió: es
         el monto que el proveedor va a cobrar. */
      ...(totalRecibido != null ? { total_amount: totalRecibido } : {}),
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
      /* La cuenta por pagar, por lo recibido. Antes se creaba por lo PEDIDO:
         si llegaban 8 de 10, el negocio quedaba debiendo dos que nunca
         recibió. */
      total_amount: totalRecibido ?? purchase.total_amount ?? 0,
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
    const body = await c.req.json() as {
      items: { product_id: string; quantity: number; unit_price?: number }[];
      canUpdateStock?: boolean; notes?: string;
    };

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

/**
 * POST /:id/void — ANULAR UNA COMPRA, incluso ya recibida.
 *
 * Cancelar una orden pendiente nunca movió nada. Anular una RECIBIDA sí: hay
 * que deshacer lo que la recepción hizo, y hacerlo en el orden correcto.
 *
 * ── Qué se deshace ────────────────────────────────────────────────────────
 *  1. EL STOCK. Se resta lo que de verdad entró (`received_quantity`, y si no
 *     está, lo pedido), con su ajuste anotado: un inventario que cambia sin
 *     dejar rastro es un inventario que nadie puede auditar.
 *  2. LA CUENTA POR PAGAR. Se cancela, así deja de contar como deuda.
 *  3. LA ORDEN, que queda `cancelled` con quién la anuló y por qué.
 *
 * ── Qué NO se deshace, y se dice ──────────────────────────────────────────
 *  · El COSTO del producto. La recepción lo dejó en el precio de esta compra y
 *    no hay dónde leer el anterior, así que se avisa cuáles productos quedaron
 *    con ese costo para revisarlos. Inventar un costo viejo sería peor.
 *  · Un ABONO ya hecho al proveedor. Si la cuenta por pagar tiene plata
 *    abonada, la anulación se RECHAZA: esa plata salió de la caja y borrar la
 *    deuda la dejaría sin explicación. Primero se revierte el abono.
 *
 * ── Si el inventario queda en negativo ────────────────────────────────────
 * Pasa cuando la mercadería ya se vendió. No se corta en cero: un cero
 * esconde el problema y el negativo lo dice —se vendió algo que no había—.
 * Se devuelve la lista para poder avisarlo en pantalla.
 */
purchases.post('/:id/void', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    const { id }   = c.req.param();
    const body     = await c.req.json().catch(() => ({} as any));
    const motivo   = String(body?.motivo ?? '').trim() || 'Anulada por error en la carga';

    const { data: previa } = await db.from('purchases')
      .select('id, status, purchase_number, supplier_id, total_amount')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!previa) return fail(c, 'Orden de compra no encontrada', 404);

    const p: any = previa;
    const numero = p.purchase_number ?? '';
    /* El estado se guarda ANTES de tocar la fila. Más abajo hay que decidir si
       había que devolver inventario, y leerlo después del cambio de estado es
       preguntarle a la fila ya anulada: la respuesta sería «no estaba
       recibida» y el stock se quedaría arriba. */
    const estadoAnterior = String(p.status ?? '');
    if (estadoAnterior === 'cancelled') {
      return fail(c, `La orden ${numero} ya estaba anulada.`, 409);
    }

    /* La cuenta por pagar se revisa ANTES de tocar nada: si tiene abonos, la
       anulación no va, y no puede quedar el stock devuelto a medias. */
    let apId: string | null = null;
    let apAbonado = 0;
    try {
      const { data: ap } = await db.from('accounts_payable')
        .select('id, paid_amount, status').eq('tenant_id', tenantId).eq('purchase_id', id)
        .neq('status', 'cancelled').maybeSingle();
      if (ap) { apId = String((ap as any).id); apAbonado = Number((ap as any).paid_amount ?? 0) || 0; }
    } catch { /* sin cuentas por pagar en este negocio */ }

    if (apAbonado > 0) {
      return fail(c,
        `La orden ${numero} ya tiene ₡${apAbonado.toLocaleString('es-CR')} abonados al proveedor. `
        + 'Primero hay que revertir el abono en Cuentas por pagar; si no, se borraría una deuda que ya se pagó.',
        409);
    }

    /* El cambio de estado se TOMA primero, y de forma atómica: si dos personas
       anulan a la vez, el stock no puede devolverse dos veces. Es la misma
       carrera que tenía el cierre de rutas. */
    const { data: tomada } = await db.from('purchases')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancelled_by: userId ?? null,
        cancel_reason: motivo,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id).eq('tenant_id', tenantId).eq('status', estadoAnterior)
      .select('id');

    if (!tomada || (tomada as any[]).length === 0) {
      /* Sin las columnas de la migración 140 el update falla entero. Se
         reintenta con lo mínimo: anular una compra mal cargada no puede
         depender de que una migración ya corrió. */
      const { data: simple } = await db.from('purchases')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', id).eq('tenant_id', tenantId).eq('status', estadoAnterior)
        .select('id');
      if (!simple || (simple as any[]).length === 0) {
        return fail(c, `La orden ${numero} ya fue anulada por otra sesión.`, 409);
      }
      console.warn('[void-compra] sin la migración 140: no se guardó el motivo');
    }

    const resumen = {
      numero, estado_anterior: estadoAnterior, motivo,
      stock_revertido: 0, unidades: 0, sin_stock: 0, fallaron: 0,
      negativos: [] as Array<{ producto: string; stock: number }>,
      costos_a_revisar: [] as string[],
      cuenta_por_pagar: 'ninguna' as 'ninguna' | 'cancelada' | 'no_se_pudo',
    };

    /* Una orden PENDIENTE no movió inventario ni generó deuda: con marcarla
       alcanza. Devolver stock que nunca entró sería el error contrario. */
    if (estadoAnterior !== 'received') return ok(c, resumen);

    // ── 1) El stock, de vuelta ──
    const { data: lineas } = await db.from('purchase_items')
      .select('product_id, quantity, received_quantity').eq('purchase_id', id);

    for (const l of ((lineas ?? []) as any[])) {
      if (!l.product_id) continue;
      /* Lo que ENTRÓ, que no siempre es lo que se pidió: si llegaron 8 de 10,
         se devuelven 8. Devolver 10 dejaría el inventario en menos dos. */
      const qty = Number(l.received_quantity ?? l.quantity ?? 0) || 0;
      if (qty <= 0) continue;

      const { data: prod } = await db.from('products')
        .select('name, stock_quantity, tracks_stock').eq('id', l.product_id).maybeSingle();
      if (!prod) { resumen.fallaron++; continue; }
      if ((prod as any).tracks_stock === false) { resumen.sin_stock++; continue; }

      const antes = Number((prod as any).stock_quantity ?? 0);
      const despues = Math.round((antes - qty) * 1000) / 1000;

      const { error: eProd } = await db.from('products')
        .update({ stock_quantity: despues, updated_at: new Date().toISOString() })
        .eq('id', l.product_id);
      if (eProd) { resumen.fallaron++; continue; }

      await db.from('stock_adjustments').insert({
        tenant_id: tenantId, product_id: l.product_id, user_id: userId ?? null,
        type: 'decrease', quantity: qty, stock_before: antes, stock_after: despues,
        reason: `Anulación de compra ${numero}`.trim(),
        notes: motivo,
      });

      resumen.stock_revertido++;
      resumen.unidades += qty;
      if (despues < 0) resumen.negativos.push({ producto: String((prod as any).name ?? ''), stock: despues });
      resumen.costos_a_revisar.push(String((prod as any).name ?? ''));
    }

    // ── 2) La cuenta por pagar ──
    if (apId) {
      const { error } = await db.from('accounts_payable')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', apId).eq('tenant_id', tenantId);
      resumen.cuenta_por_pagar = error ? 'no_se_pudo' : 'cancelada';
      if (error) console.warn('[void-compra] no se pudo cancelar la CxP:', error.message);
    }

    return ok(c, resumen);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default purchases;
