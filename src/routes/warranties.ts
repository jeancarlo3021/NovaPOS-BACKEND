import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * Garantías. Ver migrations/95_warranties.sql
 *
 * El caso se abre cuando el cliente trae el producto, y va cambiando de estado
 * hasta cerrarse. Cada cambio queda en la bitácora: sin eso, "¿en qué quedó lo
 * de don Rafael?" no tiene respuesta.
 */
const warranties = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const STATUSES = ['open', 'with_supplier', 'approved', 'rejected', 'resolved'] as const;
const RESOLUTIONS = ['repair', 'replace', 'refund', 'credit', 'none'] as const;

const WarrantySchema = z.object({
  invoice_id: z.string().uuid().optional().nullable(),
  invoice_number: z.string().optional().nullable(),
  sold_at: z.string().optional().nullable(),
  customer_id: z.string().uuid().optional().nullable(),
  customer_name: z.string().optional().nullable(),
  customer_phone: z.string().optional().nullable(),
  product_id: z.string().uuid().optional().nullable(),
  product_name: z.string().min(1),
  serial: z.string().optional().nullable(),
  quantity: z.number().positive().optional().default(1),
  warranty_until: z.string().optional().nullable(),
  out_of_warranty: z.boolean().optional().default(false),
  issue: z.string().min(1),
  photos: z.array(z.string()).optional().default([]),
  supplier_id: z.string().uuid().optional().nullable(),
  supplier_ref: z.string().optional().nullable(),
});

/** Consecutivo GAR-000001. Igual criterio que proformas y pedidos. */
async function nextNumber(tenantId: string): Promise<string> {
  const { count } = await db.from('warranties')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  return `GAR-${String((count ?? 0) + 1).padStart(6, '0')}`;
}

// GET / — casos, con filtros de estado y búsqueda.
warranties.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status');
    const q = c.req.query('q');
    let query = db.from('warranties').select('*').eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }).limit(500);
    if (status && status !== 'all') {
      // "abiertos" = todo lo que todavía no se cerró, que es la vista de trabajo.
      if (status === 'pending') query = query.not('status', 'in', '("resolved","rejected")');
      else query = query.eq('status', status);
    }
    if (q) {
      query = query.or(
        `number.ilike.%${q}%,product_name.ilike.%${q}%,customer_name.ilike.%${q}%,serial.ilike.%${q}%,invoice_number.ilike.%${q}%`);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

warranties.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('warranties').select('*')
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Caso no encontrado', 404);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /lookup/:invoiceNumber — trae la venta para abrir el caso sin teclear todo.
warranties.get('/lookup/:invoiceNumber', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const num = c.req.param('invoiceNumber');
    const { data: inv } = await db.from('invoices')
      .select('id, invoice_number, created_at, customer_id, customer_name, customer_phone, status')
      .eq('tenant_id', tenantId).eq('invoice_number', num).maybeSingle();
    if (!inv) return fail(c, 'No se encontró esa factura', 404);

    const { data: items } = await db.from('invoice_items')
      .select('product_id, product_name, quantity, unit_price').eq('invoice_id', (inv as any).id);

    // Meses de garantía por producto, para calcular la vigencia de cada línea.
    const ids = (items ?? []).map((i: any) => i.product_id).filter(Boolean);
    const { data: prods } = ids.length
      ? await db.from('products').select('id, warranty_months').eq('tenant_id', tenantId).in('id', ids)
      : { data: [] as any[] };
    const monthsById = new Map((prods ?? []).map((p: any) => [String(p.id), Number(p.warranty_months ?? 0)]));

    const soldAt = new Date((inv as any).created_at);
    return ok(c, {
      invoice: inv,
      items: (items ?? []).map((i: any) => {
        const months = monthsById.get(String(i.product_id)) ?? 0;
        let until: string | null = null;
        if (months > 0) {
          const d = new Date(soldAt);
          d.setMonth(d.getMonth() + months);
          until = d.toISOString().slice(0, 10);
        }
        return { ...i, warranty_months: months, warranty_until: until };
      }),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

warranties.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({} as any));
    const parsed = WarrantySchema.safeParse(body);
    if (!parsed.success) return fail(c, 'Datos incompletos: ' + parsed.error.message, 422);

    const { data, error } = await db.from('warranties').insert({
      tenant_id: tenantId,
      number: await nextNumber(tenantId),
      ...parsed.data,
      status: 'open',
      events: [{
        at: new Date().toISOString(), by: userId ?? null,
        from: null, to: 'open', note: 'Caso abierto',
      }],
      created_by: userId,
    }).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

warranties.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({} as any));
    const patch: any = { updated_at: new Date().toISOString() };
    for (const f of ['product_name', 'serial', 'quantity', 'issue', 'photos', 'customer_name',
      'customer_phone', 'supplier_id', 'supplier_ref', 'warranty_until', 'out_of_warranty',
      'resolution', 'resolution_notes']) {
      if (body?.[f] !== undefined) patch[f] = body[f] === '' ? null : body[f];
    }
    const { data, error } = await db.from('warranties').update(patch)
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/status — mueve el caso y deja constancia de quién y por qué.
warranties.post('/:id/status', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));
    const status = String(body?.status ?? '');
    if (!(STATUSES as readonly string[]).includes(status)) return fail(c, 'Estado inválido', 422);
    if (body?.resolution && !(RESOLUTIONS as readonly string[]).includes(String(body.resolution))) {
      return fail(c, 'Resolución inválida', 422);
    }

    const { data: prev } = await db.from('warranties')
      .select('status, events').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!prev) return fail(c, 'Caso no encontrado', 404);

    const now = new Date().toISOString();
    const log = Array.isArray((prev as any).events) ? (prev as any).events : [];
    const patch: any = {
      status,
      events: [...log, {
        at: now, by: userId ?? null,
        from: (prev as any).status, to: status, note: body?.note ?? null,
      }].slice(-100),
      updated_at: now,
    };
    if (body?.resolution !== undefined) patch.resolution = body.resolution || null;
    if (body?.resolution_notes !== undefined) patch.resolution_notes = body.resolution_notes || null;
    // Fechas que el negocio necesita para reclamar: cuánto lleva afuera.
    if (status === 'with_supplier') patch.sent_at = now;
    if (status === 'approved' || status === 'rejected') patch.returned_at = now;
    if (status === 'resolved') patch.closed_at = now;

    const { data, error } = await db.from('warranties').update(patch)
      .eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

warranties.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { error } = await db.from('warranties').delete()
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default warranties;
