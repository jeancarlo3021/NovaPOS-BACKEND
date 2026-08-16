import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { getUserZone } from '../utils/userZone.js';
import { nextInvoiceNumber, consecutivoFloor } from './invoices.js';
import { emitInvoiceCore } from './hacienda.js';

const accountsReceivable = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/** Mapa customer_id → zona, para filtrar/etiquetar CxC por zona. */
async function customerZoneMap(tenantId: string): Promise<Map<string, string | null>> {
  // Paginado por el mismo motivo que la lista de cuentas: pasados los 1000
  // clientes, los que quedaban fuera aparecían SIN zona y el filtro por zona los
  // escondía a todos — un repartidor no veía sus cuentas y no había forma de
  // saber por qué.
  const PAGE = 1000;
  const map = new Map<string, string | null>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('customers')
      .select('id, zone').eq('tenant_id', tenantId).range(from, from + PAGE - 1);
    if (error) break;
    const chunk = data ?? [];
    for (const c of chunk as any[]) map.set(c.id, c.zone ?? null);
    if (chunk.length < PAGE) break;
  }
  return map;
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
    // Paginado: Supabase devuelve máximo 1000 filas por consulta. Sin esto, un
    // negocio con muchas cuentas recibía solo las 1000 más recientes y las
    // viejas —con sus clientes— simplemente no aparecían en la pantalla ni en
    // los selectores de abono e impresión.
    const PAGE = 1000;
    const all: any[] = [];
    for (let from = 0; ; from += PAGE) {
      let query = db.from('accounts_receivable').select('*')
        .eq('tenant_id', tenantId).order('created_at', { ascending: false })
        .range(from, from + PAGE - 1);
      if (customerId) query = query.eq('customer_id', customerId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const chunk = data ?? [];
      all.push(...chunk);
      if (chunk.length < PAGE) break;   // última página
    }
    let rows = all.map(withDerivedStatus);
    // Datos de la factura de origen: número y, sobre todo, si el comprobante
    // llegó a HACIENDA.
    //
    // «Tiene factura» y «tiene comprobante electrónico» no son lo mismo: una
    // venta documentada con tiquete CORRIENTE crea su factura interna pero nunca
    // se declaró. Confundirlas hacía que al cobrar esas cuentas el sistema
    // creyera que el ingreso ya estaba declarado y no emitiera nada.
    const invIds = [...new Set(rows.filter((r: any) => r.invoice_id).map((r: any) => r.invoice_id))];
    if (invIds.length > 0) {
      const byId = new Map<string, any>();
      // Paginado: un negocio con muchas cuentas supera las 1000 facturas.
      const PAGE_I = 500;
      for (let i = 0; i < invIds.length; i += PAGE_I) {
        const { data: invs } = await db.from('invoices')
          .select('id, invoice_number, fe_clave, document_type')
          .in('id', invIds.slice(i, i + PAGE_I));
        for (const inv of (invs ?? []) as any[]) byId.set(inv.id, inv);
      }
      rows = rows.map((r: any) => {
        const inv = r.invoice_id ? byId.get(r.invoice_id) : null;
        if (!inv) return { ...r, invoice_electronic: false };
        return {
          ...r,
          invoice_number: r.invoice_number ?? inv.invoice_number,
          // Electrónico = tiene clave de Hacienda. El tipo de documento por sí
          // solo no basta: una venta marcada como electrónica que fue rechazada
          // tampoco quedó declarada.
          invoice_electronic: !!inv.fe_clave,
          invoice_document_type: inv.document_type ?? null,
        };
      });
    } else {
      rows = rows.map((r: any) => ({ ...r, invoice_electronic: false }));
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
    const { amount, method, note, created_at, batch_id } = await c.req.json() as {
      amount: number; method?: string; note?: string; created_at?: string;
      /** Agrupa los abonos de un mismo pago masivo. */
      batch_id?: string;
    };
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
    if (batch_id) payment.batch_id = batch_id;

    let ins = await db.from('accounts_receivable_payments').insert(payment);
    // La columna `batch_id` es de la migración 89: si no corrió, el abono se
    // registra igual sin agrupar. Perder el vínculo del pago masivo es molesto;
    // perder el abono sería un descuadre de plata.
    if (ins.error && /batch_id/.test(ins.error.message ?? '')) {
      const { batch_id: _b, ...rest } = payment;
      ins = await db.from('accounts_receivable_payments').insert(rest);
    }
    if (ins.error) throw new Error(ins.error.message);

    const patch: Record<string, any> = {
      paid_amount: newPaid, status, updated_at: new Date().toISOString(),
    };
    // Momento en que la cuenta queda CANCELADA. `updated_at` no sirve para esto:
    // cambia con cualquier edición posterior, así que la fecha de cancelación se
    // perdía apenas alguien tocaba la cuenta.
    if (status === 'paid') {
      patch.paid_at = payment.created_at ?? new Date().toISOString();
    }

    let upd = await db.from('accounts_receivable').update(patch).eq('id', id).select().single();
    if (upd.error && /paid_at/.test(upd.error.message ?? '')) {
      const { paid_at: _p, ...rest } = patch;
      upd = await db.from('accounts_receivable').update(rest).eq('id', id).select().single();
    }
    if (upd.error) throw new Error(upd.error.message);
    return ok(c, upd.data);
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
    const patch: Record<string, any> = {
      paid_amount: newPaid, status, updated_at: new Date().toISOString(),
    };
    // Si la cuenta deja de estar cancelada, la fecha de cancelación se borra: una
    // cuenta con saldo y con fecha de cancelación es un dato que se contradice a
    // sí mismo, y después nadie sabe cuál de los dos creer.
    if (status !== 'paid') patch.paid_at = null;
    let upd = await db.from('accounts_receivable').update(patch)
      .eq('id', receivableId).eq('tenant_id', tenantId);
    if (upd.error && /paid_at/.test(upd.error.message ?? '')) {
      const { paid_at: _p, ...rest } = patch;
      upd = await db.from('accounts_receivable').update(rest)
        .eq('id', receivableId).eq('tenant_id', tenantId);
    }

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

// ══════════════════════════════════════════════════════════════════════════
// COMPROBANTE DE UN ABONO
// ══════════════════════════════════════════════════════════════════════════
//
// body: { customer_id?, customer_name?, amount, document_type, batch_id?,
//         payment_method? }
//
// ── Qué NO hace, y por qué ────────────────────────────────────────────────
// No se emite por cuentas cuyo ingreso YA se declaró a Hacienda. Una venta a
// crédito documentada electrónicamente emitió su comprobante al venderse, con
// condición de venta «crédito»; emitir otro al cobrar declararía el mismo
// ingreso dos veces.
//
// «Ya se declaró» = la factura de origen tiene CLAVE de Hacienda. No basta con
// que exista una factura: una venta con tiquete CORRIENTE crea su factura
// interna y nunca se declaró, así que al cobrarla sí corresponde emitir.
//
// Si el front manda `account_ids`, acá se recalcula el monto elegible contra la
// base: una regla fiscal no puede vivir solo en la pantalla.
//
// ── Sin caja ──────────────────────────────────────────────────────────────
// `cash_session_id` queda en NULL a propósito. Un abono se cobra muchas veces
// fuera del POS —en la oficina, o por depósito—, y meterlo al arqueo haría que
// al cajero le sobre plata que nunca pasó por su gaveta.
accountsReceivable.post('/emit-receipt', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const b = await c.req.json().catch(() => ({} as any));

    let amount = Number(b?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return fail(c, 'Monto inválido', 422);

    // Verificación contra la BASE de qué cuentas no se han declarado. El front
    // ya filtró, pero esto es lo que impide que un cliente viejo, una llamada
    // directa o un error de pantalla dupliquen un ingreso ante Hacienda.
    const accountIds: string[] = Array.isArray(b?.account_ids) ? b.account_ids : [];
    if (accountIds.length > 0) {
      const { data: accs } = await db.from('accounts_receivable')
        .select('id, invoice_id').eq('tenant_id', tenantId).in('id', accountIds);
      const invIds = [...new Set((accs ?? []).map((a: any) => a.invoice_id).filter(Boolean))];
      const declared = new Set<string>();
      if (invIds.length) {
        const { data: invs } = await db.from('invoices')
          .select('id, fe_clave').in('id', invIds as string[]);
        for (const i of (invs ?? []) as any[]) if (i.fe_clave) declared.add(i.id);
      }
      const elegibles = (accs ?? []).filter((a: any) => !a.invoice_id || !declared.has(a.invoice_id));
      if (elegibles.length === 0) {
        return fail(c,
          'Todas esas cuentas ya se declararon a Hacienda al venderse. '
          + 'Emitir otro comprobante duplicaría el ingreso.', 409);
      }
      // No se topa el monto contra el saldo: este endpoint se llama DESPUÉS de
      // aplicar los abonos, así que el saldo de esas cuentas ya es cero y el
      // tope daría siempre 0. Lo que se valida acá es que exista al menos una
      // cuenta sin declarar; el monto lo calcula quien aplicó los abonos, que es
      // el único que sabe cuánto le tocó a cada una.
    }

    const docType = String(b?.document_type ?? '');
    if (!['ticket', 'tiquete_electronico', 'factura_electronica'].includes(docType)) {
      return fail(c, 'Tipo de comprobante inválido', 422);
    }

    // El monto recibido YA incluye el impuesto: el cliente pagó eso y el
    // comprobante tiene que decir eso. Se despeja la base con el mismo criterio
    // del POS (redondeo a colón), para que el total salga exacto.
    const ivaRate = Number(b?.iva_rate ?? 13);
    const base = ivaRate > 0 ? Math.round((amount / (1 + ivaRate / 100)) * 100) / 100 : amount;
    const tax = Math.round(amount - base);
    const total = Math.round(base) + tax;

    const floor = await consecutivoFloor(tenantId);
    let finalNumber = await nextInvoiceNumber(tenantId, 0, floor);
    let inv: any = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await db.from('invoices').insert({
        tenant_id: tenantId,
        invoice_number: finalNumber,
        customer_id: b?.customer_id ?? null,
        customer_name: b?.customer_name ?? null,
        subtotal: base, tax_amount: tax, total,
        discount_amount: 0,
        payment_method: b?.payment_method ?? 'cash',
        status: 'completed',
        // Sin caja: el abono no entra al arqueo (ver arriba).
        cash_session_id: null,
        cashier_id: c.get('userId') ?? null,
        document_type: docType === 'ticket' ? 'ticket' : docType,
        notes: b?.batch_id ? `Abono a cuenta · lote ${b.batch_id}` : 'Abono a cuenta',
        issued_at: new Date().toISOString(),
      }).select().single();

      if (!res.error) { inv = res.data; break; }
      const msg = (res.error as any)?.message ?? '';
      const isDup = (res.error as any)?.code === '23505' || /duplicate key|invoice_number_key/i.test(msg);
      if (!isDup) throw new Error(msg);
      finalNumber = await nextInvoiceNumber(tenantId, attempt + 1, floor);
    }
    if (!inv) return fail(c, 'No se pudo generar el comprobante (número duplicado)', 409);

    // Una sola línea: «Abono a cuenta». La cuenta manual no tiene productos de
    // dónde sacar un detalle, y inventarlo sería declarar una venta que no fue.
    await db.from('invoice_items').insert({
      invoice_id: inv.id,
      product_id: null,
      product_name: 'Abono a cuenta',
      quantity: 1,
      unit_price: base,
      subtotal: base,
    }).then(() => {}, (e: any) => console.warn('[abono] línea:', e?.message));

    // Electrónico: se emite. Si Hacienda lo rechaza, la factura queda creada con
    // el error registrado — el abono ya se recibió y no se deshace por esto.
    if (docType !== 'ticket') {
      try {
        return await emitInvoiceCore(c, tenantId, inv.id, {});
      } catch (e: any) {
        return ok(c, {
          invoice_id: inv.id, invoice_number: inv.invoice_number,
          emitted: false, error: e?.message ?? 'No se pudo emitir',
        }, 201);
      }
    }

    return ok(c, {
      invoice_id: inv.id, invoice_number: inv.invoice_number, emitted: false,
    }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default accountsReceivable;
