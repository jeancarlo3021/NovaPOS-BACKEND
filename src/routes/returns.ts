import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { endOfDay } from '../utils/dateRange.js';

/**
 * Devoluciones.
 *
 *  · /sales    — el cliente trae mercadería. PARCIAL o total. Repone stock (salvo
 *                que venga dañada), registra el reintegro y, si la venta fue
 *                electrónica, deja constancia de la nota de crédito.
 *  · /supplier — le devolvemos al proveedor. Baja el stock y queda como saldo a
 *                favor hasta que el proveedor lo reconozca.
 *
 * La ANULACIÓN total de una factura sigue viviendo en /invoices (marca la venta
 * como cancelada y repone todo): duplicarla acá desincronizaría las dos.
 */
const returns = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const SalesItemSchema = z.object({
  product_id:   z.string().uuid().optional().nullable(),
  product_name: z.string().min(1),
  quantity:     z.number().positive(),
  unit_price:   z.number().nonnegative(),
  subtotal:     z.number().nonnegative(),
});

const SupplierItemSchema = z.object({
  product_id:   z.string().uuid().optional().nullable(),
  product_name: z.string().min(1),
  quantity:     z.number().positive(),
  unit_cost:    z.number().nonnegative(),
  subtotal:     z.number().nonnegative(),
});

const totalOf = (items: any[]) =>
  Math.round(items.reduce((s, it) => s + Number(it.subtotal ?? 0), 0) * 100) / 100;

async function nextNumber(tenantId: string, table: string, prefix: string): Promise<string> {
  const { data } = await db.from(table)
    .select('number').eq('tenant_id', tenantId)
    .order('created_at', { ascending: false }).limit(1);
  const n = parseInt(String((data ?? [])[0]?.number ?? '').replace(/\D/g, ''), 10);
  return `${prefix}-${String((Number.isFinite(n) ? n : 0) + 1).padStart(6, '0')}`;
}

/** Suma (o resta) stock respetando los productos sin control de inventario. */
async function moveStock(items: any[], sign: 1 | -1): Promise<string[]> {
  const warnings: string[] = [];
  for (const it of items) {
    if (!it.product_id) continue;
    const { data: p } = await db.from('products')
      .select('stock_quantity, tracks_stock, name').eq('id', it.product_id).maybeSingle();
    if (!p) continue;
    if ((p as any).tracks_stock === false) continue;   // stock infinito: no se toca
    const next = Number((p as any).stock_quantity ?? 0) + sign * Number(it.quantity ?? 0);
    if (next < 0) warnings.push(`"${(p as any).name}" queda en negativo (${next}).`);
    const { error } = await db.from('products')
      .update({ stock_quantity: next, updated_at: new Date().toISOString() })
      .eq('id', it.product_id);
    if (error) warnings.push(`No se pudo mover el stock de "${(p as any).name}": ${error.message}`);
  }
  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEVOLUCIONES DE CLIENTE
// ─────────────────────────────────────────────────────────────────────────────

returns.get('/sales', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to = c.req.query('to');
    let q = db.from('sales_returns')
      .select('*, sales_return_items(*)')
      .eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(500);
    if (from) q = q.gte('created_at', from);
    if (to)   q = q.lte('created_at', endOfDay(to));
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ok(c, (data ?? []).map((r: any) => ({ ...r, items: r.sales_return_items ?? [] })));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /sales/invoice/:id — la venta con lo que YA se devolvió, para no dejar
// devolver más de lo vendido.
returns.get('/sales/invoice/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const { data: inv } = await db.from('invoices')
      .select('*, invoice_items(*)').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);

    const { data: prev } = await db.from('sales_returns')
      .select('id, sales_return_items(product_id, product_name, quantity)')
      .eq('tenant_id', tenantId).eq('invoice_id', id);
    const returned: Record<string, number> = {};
    for (const r of (prev ?? []) as any[]) {
      for (const it of (r.sales_return_items ?? [])) {
        const key = it.product_id ?? it.product_name;
        returned[key] = (returned[key] ?? 0) + Number(it.quantity ?? 0);
      }
    }

    const items = ((inv as any).invoice_items ?? []).map((it: any) => {
      const key = it.product_id ?? it.product_name;
      const yaDevuelto = returned[key] ?? 0;
      return {
        ...it,
        already_returned: yaDevuelto,
        returnable: Math.max(0, Number(it.quantity ?? 0) - yaDevuelto),
      };
    });
    return ok(c, { ...inv, items });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /sales — registra la devolución.
// body: { invoice_id?, customer_id?, customer_name?, reason?, resolution?,
//         restock?, cash_session_id?, fe_nc_clave?, items[] }
returns.post('/sales', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({} as any));
    const parsed = z.array(SalesItemSchema).min(1).safeParse(body?.items);
    if (!parsed.success) return fail(c, 'La devolución no tiene líneas: ' + parsed.error.message, 422);

    // No se puede devolver más de lo que se vendió (menos lo ya devuelto).
    if (body?.invoice_id) {
      const { data: prev } = await db.from('sales_returns')
        .select('sales_return_items(product_id, product_name, quantity)')
        .eq('tenant_id', tenantId).eq('invoice_id', body.invoice_id);
      const returned: Record<string, number> = {};
      for (const r of (prev ?? []) as any[]) {
        for (const it of (r.sales_return_items ?? [])) {
          const k = it.product_id ?? it.product_name;
          returned[k] = (returned[k] ?? 0) + Number(it.quantity ?? 0);
        }
      }
      const { data: inv } = await db.from('invoices')
        .select('invoice_items(product_id, product_name, quantity)')
        .eq('id', body.invoice_id).eq('tenant_id', tenantId).maybeSingle();
      const sold: Record<string, number> = {};
      for (const it of (((inv as any)?.invoice_items) ?? [])) {
        const k = it.product_id ?? it.product_name;
        sold[k] = (sold[k] ?? 0) + Number(it.quantity ?? 0);
      }
      for (const it of parsed.data) {
        const k = it.product_id ?? it.product_name;
        const disponible = (sold[k] ?? 0) - (returned[k] ?? 0);
        if (Number(it.quantity) > disponible + 1e-6) {
          return fail(c, `De "${it.product_name}" solo se pueden devolver ${disponible}. `
            + `El resto ya se devolvió o no estaba en la venta.`, 422);
        }
      }
    }

    const restock = body?.restock !== false;
    const { data: created, error } = await db.from('sales_returns').insert({
      tenant_id: tenantId,
      invoice_id: body?.invoice_id ?? null,
      invoice_number: body?.invoice_number ?? null,
      number: await nextNumber(tenantId, 'sales_returns', 'D'),
      customer_id: body?.customer_id ?? null,
      customer_name: body?.customer_name ?? null,
      reason: body?.reason ?? null,
      resolution: ['refund', 'credit', 'exchange'].includes(String(body?.resolution))
        ? body.resolution : 'refund',
      total: totalOf(parsed.data),
      restock,
      fe_nc_clave: body?.fe_nc_clave ?? null,
      cash_session_id: body?.cash_session_id ?? null,
      created_by: userId,
    }).select('*').single();
    if (error) throw new Error(error.message);

    const rows = parsed.data.map(it => ({ ...it, return_id: (created as any).id }));
    const { error: iErr } = await db.from('sales_return_items').insert(rows);
    if (iErr) throw new Error(iErr.message);

    // Mercadería que vuelve a la venta. Si viene dañada, `restock:false`.
    const warnings = restock ? await moveStock(parsed.data, 1) : [];

    // Salida de caja por el reintegro, para que el cierre cuadre.
    if (body?.cash_session_id && (created as any).resolution === 'refund') {
      try {
        await db.from('cash_movements').insert({
          cash_session_id: body.cash_session_id,
          tenant_id: tenantId,
          type: 'out',
          amount: totalOf(parsed.data),
          reason: `Devolución ${(created as any).number}${body?.invoice_number ? ` · factura ${body.invoice_number}` : ''}`,
          created_by: userId,
        });
      } catch (e: any) {
        warnings.push(`No se registró la salida de caja: ${e?.message}. Anotala a mano.`);
      }
    }

    return ok(c, { ...(created as any), items: rows, warnings }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DEVOLUCIONES A PROVEEDOR
// ─────────────────────────────────────────────────────────────────────────────

returns.get('/supplier', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status');
    let q = db.from('supplier_returns')
      .select('*, supplier_return_items(*)')
      .eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(500);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ok(c, (data ?? []).map((r: any) => ({ ...r, items: r.supplier_return_items ?? [] })));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /supplier/purchase/:id — la compra con sus líneas, para elegir qué devolver.
returns.get('/supplier/purchase/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const { data: p } = await db.from('purchases')
      .select('*, purchase_items(*), supplier:suppliers(id, name)')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!p) return fail(c, 'Compra no encontrada', 404);

    // Nombre de los productos (purchase_items solo guarda el id).
    const items = (p as any).purchase_items ?? [];
    const pids = [...new Set(items.map((it: any) => it.product_id).filter(Boolean))];
    const nameById = new Map<string, string>();
    if (pids.length) {
      const { data: prods } = await db.from('products').select('id, name').in('id', pids as string[]);
      for (const pr of (prods ?? []) as any[]) nameById.set(pr.id, pr.name);
    }

    const { data: prev } = await db.from('supplier_returns')
      .select('supplier_return_items(product_id, quantity)')
      .eq('tenant_id', tenantId).eq('purchase_id', id);
    const returned: Record<string, number> = {};
    for (const r of (prev ?? []) as any[]) {
      for (const it of (r.supplier_return_items ?? [])) {
        returned[it.product_id] = (returned[it.product_id] ?? 0) + Number(it.quantity ?? 0);
      }
    }

    return ok(c, {
      ...p,
      items: items.map((it: any) => ({
        ...it,
        product_name: nameById.get(it.product_id) ?? 'Producto',
        already_returned: returned[it.product_id] ?? 0,
        returnable: Math.max(0, Number(it.quantity ?? 0) - (returned[it.product_id] ?? 0)),
      })),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /supplier — registra la devolución al proveedor y BAJA el stock.
returns.post('/supplier', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({} as any));
    const parsed = z.array(SupplierItemSchema).min(1).safeParse(body?.items);
    if (!parsed.success) return fail(c, 'La devolución no tiene líneas: ' + parsed.error.message, 422);

    let supplierName: string | null = body?.supplier_name ?? null;
    if (body?.supplier_id && !supplierName) {
      const { data: s } = await db.from('suppliers')
        .select('name').eq('id', body.supplier_id).eq('tenant_id', tenantId).maybeSingle();
      supplierName = (s as any)?.name ?? null;
    }

    const { data: created, error } = await db.from('supplier_returns').insert({
      tenant_id: tenantId,
      purchase_id: body?.purchase_id ?? null,
      purchase_number: body?.purchase_number ?? null,
      number: await nextNumber(tenantId, 'supplier_returns', 'DP'),
      supplier_id: body?.supplier_id ?? null,
      supplier_name: supplierName,
      reason: body?.reason ?? null,
      resolution: ['credit_note', 'refund', 'replacement'].includes(String(body?.resolution))
        ? body.resolution : 'credit_note',
      total: totalOf(parsed.data),
      status: 'pending',
      created_by: userId,
    }).select('*').single();
    if (error) throw new Error(error.message);

    const rows = parsed.data.map(it => ({ ...it, return_id: (created as any).id }));
    const { error: iErr } = await db.from('supplier_return_items').insert(rows);
    if (iErr) throw new Error(iErr.message);

    // La mercadería SALE del inventario: se la llevó el proveedor.
    const warnings = await moveStock(parsed.data, -1);

    return ok(c, { ...(created as any), items: rows, warnings }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /supplier/:id/settle — el proveedor reconoció la devolución.
returns.post('/supplier/:id/settle', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('supplier_returns').update({
      status: 'settled', settled_at: new Date().toISOString(),
    }).eq('id', c.req.param('id')).eq('tenant_id', tenantId).eq('status', 'pending')
      .select('*').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'La devolución no existe o ya estaba saldada', 409);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default returns;
