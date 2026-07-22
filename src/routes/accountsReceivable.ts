import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { getUserZone } from '../utils/userZone.js';

const accountsReceivable = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/** Mapa customer_id → zona, para filtrar/etiquetar CxC por zona. */
async function customerZoneMap(tenantId: string): Promise<Map<string, string | null>> {
  const { data } = await db.from('customers').select('id, zone').eq('tenant_id', tenantId);
  return new Map((data ?? []).map((c: any) => [c.id, c.zone ?? null]));
}

const ARSchema = z.object({
  customer_id:    z.string().uuid().optional().nullable(),
  customer_name:  z.string().optional().nullable(),
  invoice_id:     z.string().uuid().optional().nullable(),
  invoice_number: z.string().optional().nullable(),
  total_amount:   z.number().positive(),
  paid_amount:    z.number().nonnegative().optional().default(0),
  due_date:       z.string().optional().nullable(),
  source:         z.enum(['pos', 'manual', 'distribution']).optional().default('manual'),
  notes:          z.string().optional().nullable(),
});

const today = () => new Date().toISOString().slice(0, 10);

// Marca como vencida (overdue) en la respuesta si pasó la fecha y no está pagada.
function withDerivedStatus(row: any) {
  if (row.status !== 'paid' && row.due_date && row.due_date < today()) {
    return { ...row, status: 'overdue' };
  }
  return row;
}

// Crea una cuenta por cobrar (reutilizable desde POS / distribución).
export async function createReceivable(tenantId: string, r: {
  customer_id?: string | null; customer_name?: string | null;
  invoice_id?: string | null; invoice_number?: string | null;
  total_amount: number; due_date?: string | null;
  source: 'pos' | 'manual' | 'distribution'; notes?: string | null;
}) {
  return db.from('accounts_receivable').insert({
    tenant_id: tenantId,
    customer_id: r.customer_id ?? null,
    customer_name: r.customer_name ?? null,
    invoice_id: r.invoice_id ?? null,
    invoice_number: r.invoice_number ?? null,
    total_amount: r.total_amount,
    paid_amount: 0,
    due_date: r.due_date ?? null,
    status: 'pending',
    source: r.source,
    notes: r.notes ?? null,
  }).select().single();
}

// GET /  ?status=&customer_id=
accountsReceivable.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status');
    const customerId = c.req.query('customer_id');
    let query = db.from('accounts_receivable').select('*')
      .eq('tenant_id', tenantId).order('created_at', { ascending: false });
    if (customerId) query = query.eq('customer_id', customerId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    let rows = (data ?? []).map(withDerivedStatus);
    // Backfill del nº de factura para las cuentas que solo tienen invoice_id.
    const needInv = rows.filter((r: any) => !r.invoice_number && r.invoice_id).map((r: any) => r.invoice_id);
    if (needInv.length > 0) {
      const { data: invs } = await db.from('invoices').select('id, invoice_number').in('id', needInv);
      const map = new Map((invs ?? []).map((i: any) => [i.id, i.invoice_number]));
      rows = rows.map((r: any) => (!r.invoice_number && r.invoice_id && map.get(r.invoice_id))
        ? { ...r, invoice_number: map.get(r.invoice_id) } : r);
    }
    if (status) rows = rows.filter((r: any) => r.status === status);

    // Zona: restricción por usuario (repartidor) o filtro por query. Etiqueta cada CxC.
    const zmap = await customerZoneMap(tenantId);
    rows = rows.map((r: any) => ({ ...r, zone: r.customer_id ? (zmap.get(r.customer_id) ?? null) : null }));
    const filterZone = (await getUserZone(c.get('userId'))) ?? c.req.query('zone') ?? null;
    if (filterZone) rows = rows.filter((r: any) => r.zone === filterZone);

    return ok(c, rows);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /summary — totales y saldo por cliente
accountsReceivable.get('/summary', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data } = await db.from('accounts_receivable').select('*')
      .eq('tenant_id', tenantId);
    let rows = (data ?? []).map(withDerivedStatus);

    // Zona por cliente + restricción/filtro.
    const zmap = await customerZoneMap(tenantId);
    rows = rows.map((r: any) => ({ ...r, zone: r.customer_id ? (zmap.get(r.customer_id) ?? null) : null }));
    const filterZone = (await getUserZone(c.get('userId'))) ?? c.req.query('zone') ?? null;
    if (filterZone) rows = rows.filter((r: any) => r.zone === filterZone);

    const outstanding = rows.reduce((s: number, r: any) => s + (Number(r.total_amount) - Number(r.paid_amount)), 0);
    const overdue = rows.filter((r: any) => r.status === 'overdue');
    const overdueAmount = overdue.reduce((s: number, r: any) => s + (Number(r.total_amount) - Number(r.paid_amount)), 0);
    const byCustomer: Record<string, { customer_id: string | null; customer_name: string; zone: string | null; balance: number; count: number }> = {};
    for (const r of rows) {
      const bal = Number(r.total_amount) - Number(r.paid_amount);
      if (bal <= 0) continue;
      const key = r.customer_id ?? r.customer_name ?? 'sin';
      if (!byCustomer[key]) byCustomer[key] = { customer_id: r.customer_id ?? null, customer_name: r.customer_name ?? 'Sin cliente', zone: r.zone ?? null, balance: 0, count: 0 };
      byCustomer[key].balance += bal;
      byCustomer[key].count += 1;
    }
    return ok(c, {
      outstanding, overdue_count: overdue.length, overdue_amount: overdueAmount,
      pending_count: rows.filter((r: any) => r.status !== 'paid').length,
      by_customer: Object.values(byCustomer).sort((a, b) => b.balance - a.balance),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id — con historial de abonos
accountsReceivable.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data, error } = await db.from('accounts_receivable').select('*')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Cuenta por cobrar no encontrada', 404);
    // Si no guardó el nº de factura pero tiene invoice_id, lo traemos de la factura.
    let row: any = data;
    if (!row.invoice_number && row.invoice_id) {
      const { data: inv } = await db.from('invoices').select('invoice_number').eq('id', row.invoice_id).maybeSingle();
      if ((inv as any)?.invoice_number) row = { ...row, invoice_number: (inv as any).invoice_number };
    }
    const { data: payments } = await db.from('accounts_receivable_payments')
      .select('*').eq('receivable_id', id).order('created_at', { ascending: false });
    return ok(c, { ...withDerivedStatus(row), payments: payments ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST / — alta manual
accountsReceivable.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = ARSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const d = parsed.data;
    const { data, error } = await db.from('accounts_receivable')
      .insert({ ...d, tenant_id: tenantId, status: 'pending' }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /:id
accountsReceivable.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const { data, error } = await db.from('accounts_receivable')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/pay — registrar abono
accountsReceivable.post('/:id/pay', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { amount, method, note, created_at } = await c.req.json() as { amount: number; method?: string; note?: string; created_at?: string };
    if (!amount || amount <= 0) return fail(c, 'Monto inválido', 422);

    const { data: ar } = await db.from('accounts_receivable')
      .select('total_amount, paid_amount').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!ar) return fail(c, 'Cuenta no encontrada', 404);

    const newPaid = Number(ar.paid_amount) + Number(amount);
    const status = newPaid >= Number(ar.total_amount) ? 'paid' : 'partial';

    const payment: Record<string, any> = {
      tenant_id: tenantId, receivable_id: id, amount, method: method ?? 'cash', note: note ?? null,
      user_id: c.get('userId') ?? null,   // quién cobró el abono (repartidor)
    };
    // Abono registrado OFFLINE: usar el created_at real (no la hora del sync), para
    // que caiga dentro de la ventana del cierre del repartidor.
    if (typeof created_at === 'string' && !isNaN(Date.parse(created_at))) {
      payment.created_at = created_at;
    }
    await db.from('accounts_receivable_payments').insert(payment);
    const { data, error } = await db.from('accounts_receivable')
      .update({ paid_amount: newPaid, status, updated_at: new Date().toISOString() })
      .eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /payments/:paymentId/void — ANULAR un abono. Solo administrador, gerente,
// contador o propietario. Borra el abono y recalcula el saldo de la cuenta.
const VOID_ROLES = new Set(['owner', 'admin', 'gerente', 'contador']);
accountsReceivable.post('/payments/:paymentId/void', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const role = String(c.get('role') ?? '');
    if (!VOID_ROLES.has(role)) {
      return fail(c, 'Solo el administrador, gerente o contador pueden anular abonos.', 403);
    }
    const { paymentId } = c.req.param();
    const { data: pay } = await db.from('accounts_receivable_payments')
      .select('id, receivable_id, amount, voided_at').eq('id', paymentId).eq('tenant_id', tenantId).maybeSingle();
    if (!pay) return fail(c, 'Abono no encontrado', 404);
    if ((pay as any).voided_at) return fail(c, 'El abono ya estaba anulado', 409);

    const receivableId = (pay as any).receivable_id;
    // Borrado LÓGICO: se marca como anulado (con quién y cuándo). Si las columnas
    // aún no existen (migración 63 sin correr), cae a borrado físico.
    const vUpd = await db.from('accounts_receivable_payments')
      .update({ voided_at: new Date().toISOString(), voided_by: c.get('userId') ?? null })
      .eq('id', paymentId).eq('tenant_id', tenantId);
    if (vUpd.error) {
      if (/voided_at|voided_by|column/.test(vUpd.error.message)) {
        await db.from('accounts_receivable_payments').delete().eq('id', paymentId).eq('tenant_id', tenantId);
      } else { throw new Error(vUpd.error.message); }
    }

    // Recalcular paid_amount = SUMA de los abonos NO anulados (así el saldo vuelve
    // EXACTO a como estaba antes de este abono, sin arrastrar errores de resta).
    let rows: any = await db.from('accounts_receivable_payments')
      .select('amount, voided_at').eq('receivable_id', receivableId).eq('tenant_id', tenantId);
    if (rows.error && /voided_at|column/.test(rows.error.message ?? '')) {
      rows = await db.from('accounts_receivable_payments')
        .select('amount').eq('receivable_id', receivableId).eq('tenant_id', tenantId);
    }
    const newPaid = ((rows.data ?? []) as any[])
      .filter(r => !r.voided_at).reduce((s, r) => s + Number(r.amount || 0), 0);

    const { data: ar } = await db.from('accounts_receivable')
      .select('total_amount').eq('id', receivableId).eq('tenant_id', tenantId).maybeSingle();
    const total = Number((ar as any)?.total_amount ?? 0);
    const status = newPaid <= 0 ? 'pending' : newPaid >= total ? 'paid' : 'partial';
    await db.from('accounts_receivable')
      .update({ paid_amount: newPaid, status, updated_at: new Date().toISOString() })
      .eq('id', receivableId).eq('tenant_id', tenantId);

    return ok(c, { voided: true, amount: (pay as any).amount, new_paid: newPaid });
  } catch (err: any) { return fail(c, err.message, 500); }
});

accountsReceivable.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db.from('accounts_receivable').delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default accountsReceivable;
