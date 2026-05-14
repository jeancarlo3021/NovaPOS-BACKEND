import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const accountsPayable = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const AccountPayableSchema = z.object({
  supplier_id: z.string().uuid().optional().nullable(),
  description: z.string().min(1),
  total_amount: z.number().positive(),
  due_date: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  status: z.enum(['pending', 'partial', 'paid', 'overdue']).optional().default('pending'),
});

const PaymentSchema = z.object({
  amount: z.number().positive(),
  payment_method: z.string().optional().default('cash'),
  payment_date: z.string().optional(),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

// GET / — list accounts payable (?status=)
accountsPayable.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status');

    let query = db
      .from('accounts_payable')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('due_date', { ascending: true });

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /:id — single account with payments
accountsPayable.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data, error } = await db
      .from('accounts_payable')
      .select('*, accounts_payable_payments(*)')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Cuenta por pagar no encontrada', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST / — create account payable
accountsPayable.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json();
    const parsed = AccountPayableSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('accounts_payable')
      .insert({
        ...parsed.data,
        tenant_id: tenantId,
        created_by: userId,
        paid_amount: 0,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /:id — update account payable
accountsPayable.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = AccountPayableSchema.partial().safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('accounts_payable')
      .update(parsed.data)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Cuenta por pagar no encontrada', 404);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /:id/pay — record a payment
accountsPayable.post('/:id/pay', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = PaymentSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Fetch current account
    const { data: account, error: fetchError } = await db
      .from('accounts_payable')
      .select('id, total_amount, paid_amount, status')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (fetchError) throw new Error(fetchError.message);
    if (!account) return fail(c, 'Cuenta por pagar no encontrada', 404);
    if (account.status === 'paid') return fail(c, 'La cuenta ya está pagada', 400);

    // Insert payment
    const { error: paymentError } = await db
      .from('accounts_payable_payments')
      .insert({
        ...parsed.data,
        account_payable_id: id,
        created_by: userId,
        payment_date: parsed.data.payment_date ?? new Date().toISOString(),
      });

    if (paymentError) throw new Error(paymentError.message);

    // Update paid_amount and status
    const newPaidAmount = (account.paid_amount ?? 0) + parsed.data.amount;
    const newStatus =
      newPaidAmount >= account.total_amount
        ? 'paid'
        : newPaidAmount > 0
        ? 'partial'
        : 'pending';

    const { data: updated, error: updateError } = await db
      .from('accounts_payable')
      .update({ paid_amount: newPaidAmount, status: newStatus })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (updateError) throw new Error(updateError.message);
    return ok(c, updated);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default accountsPayable;
