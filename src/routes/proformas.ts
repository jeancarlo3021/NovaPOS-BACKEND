import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const proformas = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// Consecutivo PRO-000001 por tenant.
async function nextNumber(tenantId: string): Promise<string> {
  const { count } = await db.from('proformas').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  return `PRO-${String((count ?? 0) + 1).padStart(6, '0')}`;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Totales de la cotización, con descuentos.
 *
 * Dos niveles, como se negocia de verdad:
 *  · POR LÍNEA — `discount_percent` o `discount_amount` en el ítem ("te dejo la
 *    varilla al 10%").
 *  · GENERAL — sobre el documento entero ("te hago 5% en todo").
 *
 * El IVA se calcula SOBRE LA BASE YA DESCONTADA, que es como corresponde: si se
 * cobrara sobre el precio de lista, el cliente pagaría impuesto por plata que no
 * está pagando.
 */
function computeTotals(items: any[], generalPct = 0, generalAmt = 0): {
  subtotal: number; discount: number; tax: number; total: number;
} {
  let bruto = 0;
  const bases: Array<{ base: number; rate: number }> = [];

  for (const it of items ?? []) {
    const qty = Number(it.quantity) || 0;
    const price = Number(it.unit_price) || 0;
    const line = qty * price;
    bruto += line;

    // Descuento de la línea: porcentaje o monto, nunca más que la línea.
    const pct = Math.min(100, Math.max(0, Number(it.discount_percent ?? 0)));
    const amt = Math.max(0, Number(it.discount_amount ?? 0));
    const desc = Math.min(line, pct > 0 ? line * (pct / 100) : amt);
    bases.push({ base: line - desc, rate: Number(it.iva_rate ?? 0) });
  }

  const netoLineas = bases.reduce((s, b) => s + b.base, 0);

  // Descuento general: porcentaje sobre lo que quedó, o monto fijo.
  const gPct = Math.min(100, Math.max(0, Number(generalPct) || 0));
  const gAmt = Math.max(0, Number(generalAmt) || 0);
  const descGeneral = Math.min(netoLineas, gPct > 0 ? netoLineas * (gPct / 100) : gAmt);
  // Se reparte proporcionalmente para que cada tarifa de IVA reciba su parte.
  const factor = netoLineas > 0 ? (netoLineas - descGeneral) / netoLineas : 1;

  let base = 0, tax = 0;
  for (const b of bases) {
    const conDescuento = b.base * factor;
    base += conDescuento;
    tax += conDescuento * (b.rate / 100);
  }

  return {
    subtotal: r2(base),                       // base ya descontada (sin IVA)
    discount: r2(bruto - base),               // lo que se rebajó en total
    tax: r2(tax),
    total: r2(base + tax),
  };
}

// GET /proformas?status=open|converted|cancelled|all
proformas.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status') || 'open';
    let q = db.from('proformas').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(1000);
    if (status && status !== 'all') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /proformas/:id
proformas.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('proformas').select('*').eq('tenant_id', tenantId).eq('id', c.req.param('id')).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Proforma no encontrada', 404);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /proformas
proformas.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const b = await c.req.json().catch(() => ({}));
    const items = Array.isArray(b.items) ? b.items : [];
    if (items.length === 0) return fail(c, 'Agregá al menos un producto', 400);
    const { subtotal, tax, total, discount } = computeTotals(
      items, b.discount_percent, b.discount_amount);
    const row = {
      tenant_id: tenantId,
      number: await nextNumber(tenantId),
      customer_id: b.customer_id ?? null,
      customer_name: b.customer_name ?? null,
      customer_identification: b.customer_identification ?? null,
      items, subtotal, tax, total,
      discount_percent: Number(b.discount_percent ?? 0) || 0,
      discount_amount: discount,
      notes: b.notes ?? null,
      valid_until: b.valid_until || null,
      status: 'open',
      created_by: userId ?? null,
    };
    const { data, error } = await db.from('proformas').insert(row).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /proformas/:id — editar (items/cliente/notas/vigencia). No permite editar convertidas.
proformas.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const patch: any = { updated_at: new Date().toISOString() };
    if (b.customer_id !== undefined) patch.customer_id = b.customer_id ?? null;
    if (b.customer_name !== undefined) patch.customer_name = b.customer_name ?? null;
    if (b.customer_identification !== undefined) patch.customer_identification = b.customer_identification ?? null;
    if (b.notes !== undefined) patch.notes = b.notes ?? null;
    if (b.valid_until !== undefined) patch.valid_until = b.valid_until || null;
    if (Array.isArray(b.items) || b.discount_percent !== undefined || b.discount_amount !== undefined) {
      // Se recalcula con lo que venga y, para lo que no venga, con lo que la
      // proforma ya tenía: cambiar solo el descuento no puede borrar las líneas.
      const { data: prev } = await db.from('proformas')
        .select('items, discount_percent').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
      const items = Array.isArray(b.items) ? b.items : ((prev as any)?.items ?? []);
      const pct = b.discount_percent !== undefined
        ? Number(b.discount_percent) || 0
        : Number((prev as any)?.discount_percent ?? 0);
      const amt = b.discount_amount !== undefined ? Number(b.discount_amount) || 0 : 0;

      if (Array.isArray(b.items)) patch.items = b.items;
      const t = computeTotals(items, pct, amt);
      patch.subtotal = t.subtotal;
      patch.tax = t.tax;
      patch.total = t.total;
      patch.discount_percent = pct;
      patch.discount_amount = t.discount;
    }
    const { data, error } = await db.from('proformas').update(patch)
      .eq('tenant_id', tenantId).eq('id', id).neq('status', 'converted').select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /proformas/:id/convert — marcarla como convertida a venta (guarda el n° de factura).
proformas.post('/:id/convert', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const b = await c.req.json().catch(() => ({}));
    const { data, error } = await db.from('proformas')
      .update({ status: 'converted', converted_invoice: b.invoice ?? null, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('id', c.req.param('id')).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /proformas/:id/cancel — anular una proforma.
proformas.post('/:id/cancel', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('proformas')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('id', c.req.param('id')).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// DELETE /proformas/:id
proformas.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { error } = await db.from('proformas').delete().eq('tenant_id', tenantId).eq('id', c.req.param('id'));
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default proformas;
