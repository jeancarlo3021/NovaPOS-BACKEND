import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const accountsPayable = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// Schema matches actual DB columns
const APSchema = z.object({
  purchase_id:     z.string().uuid(),
  supplier_id:     z.string().uuid(),
  purchase_number: z.string().min(1),
  supplier_name:   z.string().min(1),
  total_amount:    z.number().positive(),
  paid_amount:     z.number().nonnegative().optional().default(0),
  due_date:        z.string(),
  status:          z.enum(['pending', 'partial', 'paid', 'overdue']).optional().default('pending'),
  payment_terms:   z.string().optional().nullable(),
  notes:           z.string().optional().nullable(),
});

accountsPayable.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status   = c.req.query('status');
    const purchase_id = c.req.query('purchase_id');

    let query = db.from('accounts_payable').select('*')
      .eq('tenant_id', tenantId).order('due_date', { ascending: true });
    if (status)      query = query.eq('status', status);
    if (purchase_id) query = query.eq('purchase_id', purchase_id);

    const { data, error } = await query;
    if (error) throw new Error(typeof error === 'string' ? error : (error as any).message || JSON.stringify(error));
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

accountsPayable.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const { data, error } = await db.from('accounts_payable').select('*')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(typeof error === 'string' ? error : (error as any).message || JSON.stringify(error));
    if (!data) return fail(c, 'Cuenta por pagar no encontrada', 404);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

accountsPayable.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = APSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const { data, error } = await db.from('accounts_payable')
      .insert({ ...parsed.data, tenant_id: tenantId }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

accountsPayable.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const body     = await c.req.json();
    const { data, error } = await db.from('accounts_payable')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/pay — register partial or full payment
accountsPayable.post('/:id/pay', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const { amount } = await c.req.json() as { amount: number };

    const { data: ap, error: fetchErr } = await db.from('accounts_payable')
      .select('total_amount, paid_amount').eq('id', id).eq('tenant_id', tenantId).single();
    if (fetchErr || !ap) return fail(c, 'Cuenta no encontrada', 404);

    const newPaid = Number(ap.paid_amount) + Number(amount);
    const status  = newPaid >= Number(ap.total_amount) ? 'paid' : 'partial';

    const { data, error } = await db.from('accounts_payable')
      .update({ paid_amount: newPaid, status, updated_at: new Date().toISOString() })
      .eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

accountsPayable.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const { error } = await db.from('accounts_payable').delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default accountsPayable;
