import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const admin = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// GET /owners — call admin_get_owners() RPC (SECURITY DEFINER)
// Enriquece cada tenant con info del grupo al que pertenece (si pertenece) +
// cuota mensual del grupo (saas × #sucursales + suma de planes FE).
admin.get('/owners', async (c) => {
  try {
    const { data, error } = await db.rpc('admin_get_owners');
    if (error) throw new Error(error.message);
    const owners = Array.isArray(data) ? data : [];
    if (owners.length === 0) return ok(c, owners);

    // ── Membresía: 2 queries simples + merge en JS para evitar problemas
    //    con la sintaxis de joins anidados de PostgREST. ──
    const tenantIds = owners.map((o: any) => o.id);
    const membership: Record<string, { group_id: string; group_name: string; role: string }> = {};
    try {
      // a) Filas de tenant_group_members para nuestros tenants
      const { data: members, error: mErr } = await db.from('tenant_group_members')
        .select('tenant_id, group_id, role')
        .in('tenant_id', tenantIds);
      if (mErr) console.warn('[owners] members lookup error:', mErr.message);

      // b) Datos de los grupos involucrados
      const groupIds = Array.from(new Set((members ?? []).map((r: any) => r.group_id))).filter(Boolean);
      const groupsById: Record<string, { id: string; name: string }> = {};
      if (groupIds.length > 0) {
        const { data: groups, error: gErr } = await db.from('tenant_groups')
          .select('id, name').in('id', groupIds);
        if (gErr) console.warn('[owners] groups lookup error:', gErr.message);
        for (const g of (groups ?? []) as Array<{ id: string; name: string }>) {
          groupsById[g.id] = g;
        }
      }

      // c) Indexar por tenant_id
      for (const m of (members ?? []) as Array<{ tenant_id: string; group_id: string; role: string }>) {
        const g = groupsById[m.group_id];
        membership[m.tenant_id] = {
          group_id:   m.group_id,
          group_name: g?.name ?? '(grupo sin nombre)',
          role:       m.role,
        };
      }
    } catch (e: any) { console.warn('[owners] group lookup exception:', e?.message); }

    // Cuota mensual por grupo (memoizado)
    const groupBillingCache: Record<string, number> = {};
    const getGroupBilling = async (gid: string): Promise<number> => {
      if (groupBillingCache[gid] != null) return groupBillingCache[gid];
      try {
        const { data: b } = await db.rpc('group_billing', { p_group_id: gid });
        const row = Array.isArray(b) ? b[0] : b;
        const total = Number(row?.grand_total ?? 0);
        groupBillingCache[gid] = total;
        return total;
      } catch { return 0; }
    };

    const enriched = await Promise.all(
      owners.map(async (o: any) => {
        const g = membership[o.id] ?? null;
        const groupBilling = g?.group_id ? await getGroupBilling(g.group_id) : null;
        return {
          ...o,
          group_id:      g?.group_id ?? null,
          group_name:    g?.group_name ?? null,
          group_role:    g?.role ?? null,        // 'main' | 'branch' | null
          group_billing: groupBilling,            // total mensual del grupo (saas + FE)
        };
      }),
    );

    return ok(c, enriched);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /users-lite — lista compacta de usuarios para selectores de owner.
// Devuelve id + email + full_name. No expone datos sensibles. Sirve para
// dropdowns en panel admin (ej. transferir propiedad de un grupo).
admin.get('/users-lite', async (c) => {
  try {
    const { data, error } = await db.from('users')
      .select('id, email, full_name')
      .order('full_name', { ascending: true });
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /invoices-monthly — conteo de facturas no anuladas del mes en curso por
// tenant. Reservado para tracking de Facturación Electrónica futura, donde
// el costo del servicio suele ir por volumen mensual.
// Respuesta: [{ tenant_id, count, period_start, period_end }]
admin.get('/invoices-monthly', async (c) => {
  try {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const periodEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

    const { data, error } = await db
      .from('invoices')
      .select('tenant_id, status, issued_at')
      .gte('issued_at', periodStart)
      .lt('issued_at', periodEnd);
    if (error) throw new Error(error.message);

    const counts: Record<string, number> = {};
    for (const row of data ?? []) {
      if ((row as any).status === 'cancelled') continue;
      const tid = (row as any).tenant_id as string;
      counts[tid] = (counts[tid] ?? 0) + 1;
    }
    const out = Object.entries(counts).map(([tenant_id, count]) => ({
      tenant_id, count, period_start: periodStart, period_end: periodEnd,
    }));
    return ok(c, out);
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

    const paymentDate = body.payment_date ?? new Date().toISOString().slice(0, 10);

    const { data, error } = await db
      .from('payment_receipts')
      .insert({
        tenant_id: body.tenant_id,
        type: body.type,
        amount: body.amount,
        payment_date: paymentDate,
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

    // ── Extender la suscripción cuando el comprobante es de tipo "subscription"
    // Esto hace que el "Próximo cobro" del panel admin avance automáticamente
    // tras registrar el pago, en vez de quedar congelado en la fecha vencida.
    // (Los comprobantes "invoicing" — facturación electrónica — no afectan
    // la fecha de cobro mensual del SaaS.)
    if (body.type === 'subscription') {
      try {
        // 1) Suscripción más reciente del tenant
        const { data: sub } = await db
          .from('subscriptions')
          .select('id, plan_id, ends_at, status')
          .eq('tenant_id', body.tenant_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (sub) {
          // 2) Ciclo del plan
          let cycleDays = 30;
          if (sub.plan_id) {
            const { data: plan } = await db
              .from('subscription_plans')
              .select('billing_cycle')
              .eq('id', sub.plan_id)
              .maybeSingle();
            const cycle = (plan?.billing_cycle ?? 'monthly').toLowerCase();
            cycleDays = cycle === 'yearly' ? 365 : 30;
          }

          // 3) Base de cálculo: si la suscripción ya estaba vencida (o sin
          //    ends_at), sumar desde la fecha del pago. Si seguía vigente,
          //    sumar desde ends_at para no perder días pagados.
          const now = Date.now();
          const currentEnds = sub.ends_at ? new Date(sub.ends_at).getTime() : null;
          const paymentMs   = new Date(paymentDate + 'T12:00:00').getTime();
          const baseMs = (currentEnds && currentEnds > now) ? currentEnds : paymentMs;
          const newEndsAt = new Date(baseMs + cycleDays * 86400000).toISOString();

          await db.from('subscriptions')
            .update({
              ends_at: newEndsAt,
              status: 'active',
              updated_at: new Date().toISOString(),
            })
            .eq('id', sub.id);

          // 4) Si el tenant estaba suspendido por morosidad, reactivarlo.
          await db.from('tenants')
            .update({ status: 'active', updated_at: new Date().toISOString() })
            .eq('id', body.tenant_id)
            .in('status', ['suspended', 'inactive']);
        }
      } catch (extendErr: any) {
        // No tiramos el endpoint — el comprobante se registró bien. Solo
        // logueamos para que el admin sepa que debe renovar manualmente.
        console.warn('No se pudo extender la suscripción:', extendErr?.message);
      }
    }

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

// ── FE / Kiosk config por tenant ────────────────────────────────────────────
// El admin gestiona settings de sucursales que pueden NO ser su propio
// tenant. Usa service-role (db) y no filtra por tenant del JWT.

admin.get('/tenants/:id/fe-config', async (c) => {
  try {
    const { id } = c.req.param();
    const { data: feRow } = await db.from('settings')
      .select('config').eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const { data: kioskRow } = await db.from('settings')
      .select('config').eq('tenant_id', id).eq('type', 'pos-kiosk').maybeSingle();
    return ok(c, {
      fe:    feRow?.config ?? {},
      kiosk: kioskRow?.config ?? {},
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

admin.put('/tenants/:id/fe-config', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const { fe, kiosk } = body ?? {};

    if (fe) {
      await db.from('settings').upsert({
        tenant_id: id, type: 'electronic-invoice', config: fe,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,type' });
    }
    if (kiosk) {
      await db.from('settings').upsert({
        tenant_id: id, type: 'pos-kiosk', config: kiosk,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,type' });
    }
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default admin;
