import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const admin = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// GET /owners — call admin_get_owners() RPC (SECURITY DEFINER)
admin.get('/owners', async (c) => {
  try {
    const { data, error } = await db.rpc('admin_get_owners');
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /renew — call admin_renew_subscription() RPC
admin.post('/renew', async (c) => {
  try {
    const { p_tenant_id, p_plan_id, p_ends_at } = await c.req.json();
    const { data, error } = await db.rpc('admin_renew_subscription', { p_tenant_id, p_plan_id, p_ends_at });
    if (error) throw new Error(error.message);

    // Link subscription_id on tenant (non-critical)
    if (data?.subscription_id) {
      await db.from('tenants').update({ subscription_id: data.subscription_id }).eq('id', p_tenant_id);
    }
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PATCH /tenants/:id/status — toggle active/suspended
admin.patch('/tenants/:id/status', async (c) => {
  try {
    const { id } = c.req.param();
    const { status, subscription_id } = await c.req.json();

    const { error: te } = await db.from('tenants').update({ status }).eq('id', id);
    if (te) throw new Error(te.message);

    if (subscription_id) {
      const subStatus = status === 'suspended' ? 'inactive' : 'active';
      await db.from('subscriptions').update({ status: subStatus, updated_at: new Date().toISOString() }).eq('id', subscription_id);
    }
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PATCH /tenants/:id/subscription — link subscription_id on tenant
admin.patch('/tenants/:id/subscription', async (c) => {
  try {
    const { id } = c.req.param();
    const { subscription_id } = await c.req.json();
    const { error } = await db.from('tenants').update({ subscription_id }).eq('id', id);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /delete-owner — delete tenant and all data via edge function
admin.post('/delete-owner', async (c) => {
  try {
    const { tenantId, ownerId } = await c.req.json();
    // Use service role to delete directly (edge function not available from backend)
    // Delete in dependency order
    await db.from('invoice_items').delete().eq('tenant_id', tenantId);
    await db.from('invoices').delete().eq('tenant_id', tenantId);
    await db.from('expenses').delete().eq('tenant_id', tenantId);
    await db.from('purchases').delete().eq('tenant_id', tenantId);
    await db.from('accounts_payable').delete().eq('tenant_id', tenantId);
    await db.from('products').delete().eq('tenant_id', tenantId);
    await db.from('product_categories').delete().eq('tenant_id', tenantId);
    await db.from('suppliers').delete().eq('tenant_id', tenantId);
    await db.from('cash_sessions').delete().eq('tenant_id', tenantId);
    await db.from('subscriptions').delete().eq('tenant_id', tenantId);
    await db.from('users').delete().eq('tenant_id', tenantId);
    await db.from('tenants').delete().eq('id', tenantId);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /change-plan — update plan for a tenant
admin.post('/change-plan', async (c) => {
  try {
    const { tenantId, newPlanId } = await c.req.json();
    const { error: te } = await db.from('tenants').update({ plan_id: newPlanId }).eq('id', tenantId);
    if (te) throw new Error(te.message);
    // Update active subscription plan_id
    await db.from('subscriptions').update({ plan_id: newPlanId, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('status', 'active');
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── Comprobantes de pago de tenants ────────────────────────────────────────
// Ver migrations/10_payment_receipts.sql

// GET /payment-receipts?tenant_id=&type=&from=&to=
admin.get('/payment-receipts', async (c) => {
  try {
    const tenantId = c.req.query('tenant_id');
    const type     = c.req.query('type');     // 'subscription' | 'invoicing'
    const from     = c.req.query('from');
    const to       = c.req.query('to');

    let query = db
      .from('payment_receipts')
      .select('*, tenant:tenants(id, name)')
      .order('payment_date', { ascending: false });

    if (tenantId) query = query.eq('tenant_id', tenantId);
    if (type)     query = query.eq('type', type);
    if (from)     query = query.gte('payment_date', from);
    if (to)       query = query.lte('payment_date', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /payment-receipts — registrar un comprobante
admin.post('/payment-receipts', async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json() as {
      tenant_id: string;
      type: 'subscription' | 'invoicing';
      amount: number;
      payment_date?: string;
      period_start?: string | null;
      period_end?: string | null;
      payment_method?: string | null;
      reference?: string | null;
      notes?: string | null;
      file_url?: string | null;
    };

    if (!body.tenant_id) return fail(c, 'tenant_id requerido', 422);
    if (body.type !== 'subscription' && body.type !== 'invoicing') {
      return fail(c, "type debe ser 'subscription' o 'invoicing'", 422);
    }
    if (!body.amount || Number(body.amount) <= 0) {
      return fail(c, 'amount debe ser mayor a 0', 422);
    }

    const { data, error } = await db
      .from('payment_receipts')
      .insert({
        tenant_id: body.tenant_id,
        type: body.type,
        amount: body.amount,
        payment_date: body.payment_date ?? new Date().toISOString().slice(0, 10),
        period_start: body.period_start ?? null,
        period_end: body.period_end ?? null,
        payment_method: body.payment_method ?? null,
        reference: body.reference ?? null,
        notes: body.notes ?? null,
        file_url: body.file_url ?? null,
        created_by: userId ?? null,
      })
      .select('*, tenant:tenants(id, name)')
      .single();

    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /payment-receipts/:id
admin.delete('/payment-receipts/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const { error } = await db.from('payment_receipts').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default admin;
