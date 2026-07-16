import { Hono } from 'hono';
import { db, anonClient } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { sendEmail, paymentReceiptEmailHtml, customInvoiceEmailHtml, planFeatureLabels } from '../services/emailService.js';
import { alanube, AlanubeError } from '../services/alanube.js';
import { endOfDay } from '../utils/dateRange.js';

const admin = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// Correo + nombre del dueño y nombre del negocio (para comprobantes por email).
async function ownerAndBusiness(tenantId: string): Promise<{ email?: string; businessName: string }> {
  const { data: t } = await db.from('tenants').select('name, owner_id').eq('id', tenantId).maybeSingle();
  let businessName = (t as any)?.name || 'ColónClick';
  try {
    const { data: s } = await db.from('settings').select('config').eq('tenant_id', tenantId).eq('type', 'general').maybeSingle();
    const bn = (s?.config as any)?.businessName;
    if (bn) businessName = bn;
  } catch { /* ignore */ }
  const ownerId = (t as any)?.owner_id;
  let email: string | undefined;
  if (ownerId) {
    const { data: u } = await db.from('users').select('email').eq('id', ownerId).maybeSingle();
    email = u?.email ?? undefined;
    if (!email) {
      try { const { data: au } = await db.auth.admin.getUserById(ownerId); email = au?.user?.email ?? undefined; } catch { /* ignore */ }
    }
  }
  return { email, businessName };
}

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

    // Precio de venta personalizado por tenant (override del precio del plan).
    const customPriceByTenant: Record<string, number> = {};
    try {
      const { data: subs } = await db.from('subscriptions')
        .select('tenant_id, custom_price, created_at')
        .in('tenant_id', tenantIds)
        .order('created_at', { ascending: false });
      for (const s of (subs ?? []) as any[]) {
        // Tomar la suscripción más reciente por tenant (las vienen ordenadas desc).
        if (!(s.tenant_id in customPriceByTenant) && s.custom_price != null) {
          customPriceByTenant[s.tenant_id] = Number(s.custom_price);
        }
      }
    } catch (e: any) { console.warn('[owners] custom_price lookup:', e?.message); }

    // Proveedor de FE por tenant (para mostrar/ocultar acciones de Alanube).
    const feProviderByTenant: Record<string, string> = {};
    try {
      const { data: feRows } = await db.from('settings')
        .select('tenant_id, config').eq('type', 'electronic-invoice').in('tenant_id', tenantIds);
      for (const r of (feRows ?? []) as any[]) {
        feProviderByTenant[r.tenant_id] = r.config?.fe_provider === 'alanube' ? 'alanube' : 'facturemos';
      }
    } catch (e: any) { console.warn('[owners] fe_provider lookup:', e?.message); }

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
        const customPrice = customPriceByTenant[o.id];
        return {
          ...o,
          group_id:      g?.group_id ?? null,
          group_name:    g?.group_name ?? null,
          group_role:    g?.role ?? null,        // 'main' | 'branch' | null
          group_billing: groupBilling,            // total mensual del grupo (saas + FE)
          custom_price:  customPrice ?? null,     // precio personalizado (si hay)
          fe_provider:   feProviderByTenant[o.id] ?? 'facturemos',
          // El precio efectivo de venta: personalizado si existe, si no el del plan.
          plan_price:    customPrice ?? o.plan_price,
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
      .select('tenant_id, status, issued_at, route_id')
      .gte('issued_at', periodStart)
      .lt('issued_at', periodEnd);
    if (error) throw new Error(error.message);

    const counts: Record<string, number> = {};
    const distCounts: Record<string, number> = {};
    for (const row of data ?? []) {
      if ((row as any).status === 'cancelled') continue;
      const tid = (row as any).tenant_id as string;
      if ((row as any).route_id) {
        // Factura de distribución: cuenta SOLO en distribución, no en las corrientes.
        distCounts[tid] = (distCounts[tid] ?? 0) + 1;
      } else {
        // Factura corriente (POS).
        counts[tid] = (counts[tid] ?? 0) + 1;
      }
    }
    const tids = new Set([...Object.keys(counts), ...Object.keys(distCounts)]);
    const out = Array.from(tids).map((tenant_id) => ({
      tenant_id,
      count: counts[tenant_id] ?? 0,
      distribution_count: distCounts[tenant_id] ?? 0,
      period_start: periodStart, period_end: periodEnd,
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

// POST /send-password-reset — envía al dueño un correo (vía Supabase) para que
// él mismo cambie su contraseña. body: { ownerId?, tenantId? }.
admin.post('/send-password-reset', async (c) => {
  try {
    const { ownerId, tenantId } = await c.req.json();
    // Resolver email del dueño.
    let uid: string | null = ownerId ?? null;
    if (!uid && tenantId) {
      const { data: t } = await db.from('tenants').select('owner_id').eq('id', tenantId).maybeSingle();
      uid = (t as any)?.owner_id ?? null;
    }
    if (!uid) return fail(c, 'No se encontró el usuario dueño', 422);

    let email: string | undefined;
    const { data: u } = await db.from('users').select('email').eq('id', uid).maybeSingle();
    email = u?.email ?? undefined;
    if (!email) {
      try { const { data: au } = await db.auth.admin.getUserById(uid); email = au?.user?.email ?? undefined; } catch { /* ignore */ }
    }
    if (!email) return fail(c, 'El dueño no tiene un correo válido', 422);

    // Enviar el correo de restablecimiento por medio de Supabase.
    const frontend = (process.env.FRONTEND_URL ?? '').split(',')[0]?.trim() || '';
    const redirectTo = frontend ? `${frontend}/auth/reset-password` : undefined;
    const { error } = await anonClient.auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : undefined);
    if (error) throw new Error(error.message);
    return ok(c, { message: 'Correo de cambio de contraseña enviado', email });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /set-subscription-price — fija el monto de venta del plan para un negocio.
// body: { tenantId, price }  (price null/'' = volver al precio del plan).
admin.post('/set-subscription-price', async (c) => {
  try {
    const { tenantId, price } = await c.req.json();
    if (!tenantId) return fail(c, 'tenantId requerido', 422);
    const value = (price === null || price === '' || price === undefined) ? null : Number(price);
    if (value != null && (isNaN(value) || value < 0)) return fail(c, 'Precio inválido', 422);

    // Suscripción más reciente del tenant.
    const { data: sub } = await db.from('subscriptions')
      .select('id').eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!sub) return fail(c, 'El negocio no tiene suscripción', 404);

    const { error } = await db.from('subscriptions')
      .update({ custom_price: value, updated_at: new Date().toISOString() })
      .eq('id', (sub as any).id);
    if (error) throw new Error(error.message);
    return ok(c, { custom_price: value });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /set-subscription-days — fija los DÍAS RESTANTES de la suscripción.
// body: { tenantId, days }  → ends_at = hoy + days, status 'active'.
admin.post('/set-subscription-days', async (c) => {
  try {
    const { tenantId, days } = await c.req.json();
    if (!tenantId) return fail(c, 'tenantId requerido', 422);
    const d = Number(days);
    if (isNaN(d) || d < 0 || d > 3650) return fail(c, 'Días inválidos (0 a 3650)', 422);

    // Suscripción más reciente del tenant.
    const { data: sub } = await db.from('subscriptions')
      .select('id').eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!sub) return fail(c, 'El negocio no tiene suscripción', 404);

    const endsAt = new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await db.from('subscriptions')
      .update({ ends_at: endsAt, status: 'active', updated_at: new Date().toISOString() })
      .eq('id', (sub as any).id);
    if (error) throw new Error(error.message);
    return ok(c, { ends_at: endsAt, days: d });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /change-plan — update plan for a tenant
admin.post('/change-plan', async (c) => {
  try {
    const { tenantId, newPlanId } = await c.req.json();
    if (!tenantId || !newPlanId) return fail(c, 'tenantId y newPlanId requeridos', 422);

    const { error: te } = await db.from('tenants').update({ plan_id: newPlanId }).eq('id', tenantId);
    if (te) throw new Error(te.message);

    // Actualizar la suscripción ACTIVA. Si no hay ninguna (sucursales enlazadas o
    // creadas sin plan), se CREA una — antes solo se actualizaba y quedaba el
    // tenant con plan_id pero sin suscripción activa ("básico pero a la vez no").
    const { data: updated } = await db.from('subscriptions')
      .update({ plan_id: newPlanId, status: 'active', updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('status', 'active').select('id');

    if (!updated || updated.length === 0) {
      const { data: plan } = await db.from('subscription_plans')
        .select('billing_cycle').eq('id', newPlanId).maybeSingle();
      const cycleDays = String((plan as any)?.billing_cycle ?? 'monthly').toLowerCase() === 'yearly' ? 365 : 30;
      const nowISO = new Date().toISOString();
      const endsAt = new Date(Date.now() + cycleDays * 86_400_000).toISOString();
      const { data: sub, error: sErr } = await db.from('subscriptions').insert({
        tenant_id: tenantId, plan_id: newPlanId, status: 'active',
        started_at: nowISO, ends_at: endsAt, auto_renew: true,
      }).select('id').single();
      if (sErr) throw new Error(sErr.message);
      if ((sub as any)?.id) {
        await db.from('tenants').update({ subscription_id: (sub as any).id }).eq('id', tenantId);
      }
    }
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
    let nextBilling: string | null = null;
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
          nextBilling = newEndsAt;

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

    // Enviar comprobante de pago por correo al dueño (fire-and-forget).
    (async () => {
      try {
        const { email, businessName } = await ownerAndBusiness(body.tenant_id);
        if (!email) return;
        const html = paymentReceiptEmailHtml({
          businessName,
          type: body.type,
          amount: Number(body.amount ?? 0),
          paymentDate,
          periodStart: body.period_start ?? null,
          periodEnd: body.period_end ?? null,
          paymentMethod: body.payment_method ?? null,
          reference: body.reference ?? null,
          nextBilling,
          notes: body.notes ?? null,
        });
        await sendEmail({ to: email, subject: `Comprobante de pago · ${businessName}`, html });
      } catch (e: any) { console.warn('[payment-receipt email] no se pudo enviar:', e?.message); }
    })();

    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /send-custom-invoice — factura/cobro personalizado (primer cobro) por correo,
// con las líneas que defina el admin + lo que incluye el plan del negocio.
admin.post('/send-custom-invoice', async (c) => {
  try {
    const body = await c.req.json() as {
      tenant_id: string;
      items: Array<{ description: string; amount: number }>;
      due_date?: string | null;
      notes?: string | null;
      payment_info?: string | null;
      include_plan_features?: boolean;
    };
    if (!body.tenant_id) return fail(c, 'tenant_id requerido', 422);
    const items = (body.items ?? []).filter(it => it.description?.trim() && Number(it.amount) > 0)
      .map(it => ({ description: it.description.trim(), amount: Number(it.amount) }));
    if (items.length === 0) return fail(c, 'Agregá al menos una línea con monto', 422);
    const total = items.reduce((s, it) => s + it.amount, 0);

    const { email, businessName } = await ownerAndBusiness(body.tenant_id);
    if (!email) return fail(c, 'El negocio no tiene correo de dueño', 422);

    // Nombre del dueño + plan + features.
    let ownerName: string | null = null;
    let planName: string | null = null;
    let planFeatures: string[] = [];
    try {
      const { data: t } = await db.from('tenants').select('owner_id').eq('id', body.tenant_id).maybeSingle();
      if ((t as any)?.owner_id) {
        const { data: u } = await db.from('users').select('full_name').eq('id', (t as any).owner_id).maybeSingle();
        ownerName = (u as any)?.full_name ?? null;
      }
    } catch { /* ignore */ }
    if (body.include_plan_features !== false) {
      try {
        const { data: sub } = await db.from('subscriptions')
          .select('plan_id').eq('tenant_id', body.tenant_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if ((sub as any)?.plan_id) {
          const { data: plan } = await db.from('subscription_plans')
            .select('name, features').eq('id', (sub as any).plan_id).maybeSingle();
          planName = (plan as any)?.name ?? null;
          planFeatures = planFeatureLabels((plan as any)?.features);
        }
      } catch { /* ignore */ }
    }

    const html = customInvoiceEmailHtml({
      businessName, ownerName, planName, items, total,
      dueDate: body.due_date ?? null, notes: body.notes ?? null,
      planFeatures, paymentInfo: body.payment_info ?? null,
    });
    await sendEmail({ to: email, subject: `Cobro · ${businessName}`, html });
    return ok(c, { sent: true, to: email, total });
  } catch (err: any) { return fail(c, err.message, 500); }
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

// ── Configuración GLOBAL de FE (cédula del proveedor de sistemas) ────────────
admin.get('/global-fe', async (c) => {
  try {
    const { data } = await db.from('app_config').select('value').eq('key', 'fe').maybeSingle();
    return ok(c, (data as any)?.value ?? {});
  } catch (err: any) { return fail(c, err.message, 500); }
});

admin.put('/global-fe', async (c) => {
  try {
    const body = await c.req.json();
    const value = { proveedor_sistemas: String(body?.proveedor_sistemas ?? '').replace(/\D/g, '') };
    await db.from('app_config').upsert(
      { key: 'fe', value, updated_at: new Date().toISOString() },
      { onConflict: 'key' });
    return ok(c, value);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── Planes de Facturación Electrónica (tabla fe_plans) ───────────────────────
const feOut = (r: any) => ({
  id: r.id, name: r.name, description: r.description ?? '',
  price: Number(r.price ?? 0),
  docsPerMonth: r.docs_per_month == null ? null : Number(r.docs_per_month),
  extraDocPrice: Number(r.extra_doc_price ?? 0),
  features: Array.isArray(r.features) ? r.features : [],
  is_active: r.is_active !== false,
});
const feIn = (p: any) => ({
  id: p.id, name: p.name ?? '', description: p.description ?? '',
  price: Number(p.price ?? 0),
  docs_per_month: p.docsPerMonth == null || p.docsPerMonth === '' ? null : Number(p.docsPerMonth),
  extra_doc_price: Number(p.extraDocPrice ?? 0),
  features: Array.isArray(p.features) ? p.features : [],
  is_active: p.is_active !== false,
  updated_at: new Date().toISOString(),
});

admin.get('/fe-plans', async (c) => {
  try {
    const { data, error } = await db.from('fe_plan_catalog').select('*').order('price', { ascending: true });
    if (error) throw new Error(error.message);
    return ok(c, (data ?? []).map(feOut));
  } catch (err: any) { return fail(c, err.message, 500); }
});

admin.put('/fe-plans', async (c) => {
  try {
    const body = await c.req.json();
    const plans: any[] = Array.isArray(body?.plans) ? body.plans : (Array.isArray(body) ? body : []);
    // Borrar los que ya no están, y upsertar el resto.
    const { data: existing } = await db.from('fe_plan_catalog').select('id');
    const keep = new Set(plans.map(p => p.id));
    for (const row of (existing ?? []) as any[]) {
      if (!keep.has(row.id)) await db.from('fe_plan_catalog').delete().eq('id', row.id);
    }
    for (const p of plans) {
      const { error } = await db.from('fe_plan_catalog').upsert(feIn(p), { onConflict: 'id' });
      if (error) throw new Error(error.message);
    }
    return ok(c, plans);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /tenants/:id/fe-plan — asigna (o quita) un plan FE al negocio. Copia la
// cuota del catálogo a la config FE del tenant. fe_plan_id vacío = sin FE.
admin.put('/tenants/:id/fe-plan', async (c) => {
  try {
    const { id } = c.req.param();
    const { fe_plan_id } = await c.req.json().catch(() => ({}));

    const { data: prev } = await db.from('settings').select('config')
      .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const cfg: any = { ...((prev?.config as any) ?? {}) };

    if (!fe_plan_id) {
      // Quitar el plan FE (deja la config pero sin plan ni cuota).
      cfg.fe_plan_id = null;
    } else {
      const { data: plan } = await db.from('fe_plan_catalog').select('*').eq('id', fe_plan_id).maybeSingle();
      if (!plan) return fail(c, 'Plan FE no encontrado', 404);
      cfg.fe_plan_id = (plan as any).id;
      cfg.fe_included_docs = (plan as any).docs_per_month == null ? 0 : Number((plan as any).docs_per_month);
      cfg.fe_included_nc = cfg.fe_included_nc ?? 0;
      cfg.fe_extra_fee = Number((plan as any).extra_doc_price ?? 0);
      cfg.enabled = true;
    }

    await db.from('settings').upsert(
      { tenant_id: id, type: 'electronic-invoice', config: cfg, updated_at: new Date().toISOString() },
      { onConflict: 'tenant_id,type' });
    return ok(c, { ok: true, fe_plan_id: cfg.fe_plan_id ?? null });
  } catch (err: any) { return fail(c, err.message, 500); }
});

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
      // MERGE con la config existente para no pisar campos administrados por
      // otros endpoints (certificado .p12, secretos, cuota FE, id de Alanube).
      // Solo las claves presentes en `fe` sobreescriben; el resto se conserva.
      const { data: prev } = await db.from('settings').select('config')
        .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
      const merged = { ...((prev?.config as any) ?? {}), ...fe };
      await db.from('settings').upsert({
        tenant_id: id, type: 'electronic-invoice', config: merged,
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

// ── Certificado criptográfico (.p12) por empresa — Supabase Storage PRIVADO ─────
const FE_CERT_BUCKET = 'fe-certificates';

// Certificado .p12 del ambiente activo del tenant (con fallback al legacy).
function resolveCert(cfg: Record<string, any>): { path: string; filename?: string } | null {
  const isSandbox = String(cfg.environment ?? 'production') === 'sandbox';
  const cert = (isSandbox ? cfg.certificate_sandbox : cfg.certificate_production) ?? cfg.certificate;
  return cert?.path ? cert : null;
}

// POST /tenants/:id/fe-certificate — sube el .p12 (base64) a Storage y guarda
// metadata + PIN/clave en la config FE. body: { file_base64, filename, p12_password, hacienda_pin }.
admin.post('/tenants/:id/fe-certificate', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const { file_base64, filename, p12_password, hacienda_pin, environment } = body ?? {};
    if (!file_base64) return fail(c, 'Falta el archivo del certificado (.p12)', 422);
    const buf = Buffer.from(String(file_base64).replace(/^data:[^;]*;base64,/, ''), 'base64');
    if (buf.length === 0) return fail(c, 'El archivo del certificado está vacío', 422);

    // Ambiente del .p12: producción o QA/sandbox (cada uno su archivo).
    const env: 'production' | 'sandbox' = environment === 'sandbox' ? 'sandbox' : 'production';

    // Bucket privado (idempotente).
    await db.storage.createBucket(FE_CERT_BUCKET, { public: false }).catch(() => {});
    const path = `${id}/certificado-${env}.p12`;
    const { error: upErr } = await db.storage.from(FE_CERT_BUCKET)
      .upload(path, buf, { contentType: 'application/x-pkcs12', upsert: true });
    if (upErr) throw new Error(upErr.message);

    // Metadata + secretos en la config FE (electronic-invoice), por ambiente.
    const { data: row } = await db.from('settings').select('config')
      .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const cfg: Record<string, any> = { ...((row as any)?.config ?? {}) };
    const certMeta = { path, filename: filename || `certificado-${env}.p12`, uploaded_at: new Date().toISOString() };
    if (env === 'sandbox') {
      cfg.certificate_sandbox = certMeta;
      if (p12_password !== undefined) cfg.p12_password_sandbox = String(p12_password);
      if (hacienda_pin !== undefined) cfg.hacienda_pin_sandbox = String(hacienda_pin);
    } else {
      cfg.certificate_production = certMeta;
      if (p12_password !== undefined) cfg.p12_password_production = String(p12_password);
      if (hacienda_pin !== undefined) cfg.hacienda_pin_production = String(hacienda_pin);
    }
    // Compat: mantené `certificate`/`p12_password` apuntando al de producción.
    if (env === 'production') {
      cfg.certificate = certMeta;
      if (p12_password !== undefined) cfg.p12_password = String(p12_password);
      if (hacienda_pin !== undefined) cfg.hacienda_pin = String(hacienda_pin);
    }
    await db.from('settings').upsert({
      tenant_id: id, type: 'electronic-invoice', config: cfg, updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' });

    return ok(c, { ok: true, certificate: certMeta });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// DELETE /tenants/:id/fe-certificate?environment=production|sandbox — borra el
// .p12 de ese ambiente. Sin `environment` borra todo (compat).
admin.delete('/tenants/:id/fe-certificate', async (c) => {
  try {
    const { id } = c.req.param();
    const environment = c.req.query('environment');
    const { data: row } = await db.from('settings').select('config')
      .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const cfg: Record<string, any> = { ...((row as any)?.config ?? {}) };

    if (environment === 'sandbox') {
      await db.storage.from(FE_CERT_BUCKET).remove([`${id}/certificado-sandbox.p12`]).catch(() => {});
      delete cfg.certificate_sandbox; delete cfg.p12_password_sandbox;
    } else if (environment === 'production') {
      await db.storage.from(FE_CERT_BUCKET).remove([`${id}/certificado-production.p12`, `${id}/certificado.p12`]).catch(() => {});
      delete cfg.certificate_production; delete cfg.p12_password_production;
      delete cfg.certificate; delete cfg.p12_password;
    } else {
      // Sin ambiente: limpia todo (compat con el flujo viejo).
      await db.storage.from(FE_CERT_BUCKET).remove([
        `${id}/certificado.p12`, `${id}/certificado-production.p12`, `${id}/certificado-sandbox.p12`,
      ]).catch(() => {});
      delete cfg.certificate; delete cfg.p12_password; delete cfg.hacienda_pin;
      delete cfg.certificate_production; delete cfg.p12_password_production;
      delete cfg.certificate_sandbox; delete cfg.p12_password_sandbox;
    }
    await db.from('settings').upsert({
      tenant_id: id, type: 'electronic-invoice', config: cfg, updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' });
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /tenants/:id/fe-certificate-url — URL firmada temporal para descargar el
// .p12 (ej. para subirlo a Alanube en el Paso 2). Solo super-admin.
admin.get('/tenants/:id/fe-certificate-url', async (c) => {
  try {
    const { id } = c.req.param();
    const { data, error } = await db.storage.from(FE_CERT_BUCKET)
      .createSignedUrl(`${id}/certificado.p12`, 300); // 5 min
    if (error) throw new Error(error.message);
    return ok(c, { url: data?.signedUrl ?? null });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /alanube/ping — verifica el token/ambiente de Alanube del servidor.
// No hay GET de listado en CRI, así que probamos POST /companies con body vacío:
//   401/403 → token inválido · 400/422 → token OK (llegó a la validación) · 2xx → OK.
admin.get('/alanube/ping', async (c) => {
  // ?env=production|sandbox para probar cualquiera de los dos ambientes.
  const client = alanube.forEnv(c.req.query('env') ?? alanube.defaultEnv());
  const env = client.env; const url = client.baseUrl();
  try {
    await client.createCompany({});
    return ok(c, { ok: true, authenticated: true, env, base_url: url, note: 'Conexión y token OK' });
  } catch (err: any) {
    const status = err instanceof AlanubeError ? err.status : 500;
    if (status === 401 || status === 403) {
      return fail(c, `Token de Alanube inválido o sin permisos (401). ambiente=${env}`, 401);
    }
    if (status === 400 || status === 422) {
      return ok(c, { ok: true, authenticated: true, env, base_url: url, note: 'Token OK (Alanube respondió validación del payload de prueba)' });
    }
    return fail(c, `${err.message} · ambiente=${env} · url=${url}`, status);
  }
});

// GET /tenants/:id/alanube/verify — DIAGNÓSTICO: ¿la empresa que usa la emisión
// existe en la cuenta/ambiente que apunta el token? Consulta GET /companies/{id}
// con el MISMO ambiente + company_id que usaría la emisión.
admin.get('/tenants/:id/alanube/verify', async (c) => {
  try {
    const { id } = c.req.param();
    const { data: row } = await db.from('settings').select('config')
      .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const cfg: Record<string, any> = { ...((row as any)?.config ?? {}) };
    const isSandbox = String(cfg.environment ?? 'production') === 'sandbox';
    const companyId = (isSandbox ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id;
    const client = alanube.forEnv(cfg.environment);
    const out: any = { environment: client.env, base_url: client.baseUrl(), company_id: companyId ?? null };
    if (!companyId) return ok(c, { ...out, exists: false, note: 'No hay company_id guardado para este ambiente.' });
    try {
      const company = await client.getCompany(String(companyId));
      return ok(c, { ...out, exists: true, api_status: company?.company?.apiStatus ?? company?.apiStatus ?? null });
    } catch (e: any) {
      const status = e instanceof AlanubeError ? e.status : 500;
      return ok(c, { ...out, exists: false, error: e?.message, status,
        note: status === 404 ? 'La empresa NO existe en este ambiente/cuenta. El token de emisión apunta a otra cuenta o la empresa se creó en otro ambiente.' : undefined });
    }
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── Alanube: dar de alta la empresa (emisor) — Paso 3 ─────────────────────────
// Construye el payload de POST /cri/v1/companies desde la config FE del tenant:
//  · datos del emisor (nombre, identificación, dirección, actividad, email)
//  · certificate: el .p12 (bajado de Storage → base64) + su contraseña
//  · token: credenciales API generadas en ATV (usuario/contraseña)
// Guarda el id de la empresa que devuelve Alanube en cfg.alanube_company_id.
//
// NOTA: los nombres de los sub-objetos `certificate` y `token` siguen las
// convenciones CRI de Alanube; si el sandbox reporta un campo distinto, se
// ajusta SOLO en `buildAlanubeCompanyPayload`.
function buildAlanubeCompanyPayload(cfg: Record<string, any>, p12Base64: string, env: 'sandbox' | 'production' = 'production') {
  const others = String(cfg.emisor_address ?? '').trim();
  const activity = String(cfg.economic_activity_code ?? '').trim();
  const email = String(cfg.emisor_email ?? '').trim();
  const phone = String(cfg.emisor_phone ?? '').replace(/\D/g, '');

  // Credenciales POR AMBIENTE (con fallback a las genéricas). Las de producción y
  // pruebas de Hacienda son distintas.
  const prod = env === 'production';
  const atvUser = String((prod ? cfg.atv_username_production : cfg.atv_username_sandbox) || cfg.atv_username || '').trim();
  // La contraseña ATV es su PROPIO valor (NO el PIN del certificado — eran cosas
  // distintas y el fallback anterior causaba "Invalid credentials").
  const atvPass = String((prod ? cfg.atv_password_production : cfg.atv_password_sandbox) || cfg.atv_password || '');
  const p12Pass = String(
    (prod ? cfg.p12_password_production : cfg.p12_password_sandbox)
    || (prod ? cfg.hacienda_pin_production : cfg.hacienda_pin_sandbox)
    || cfg.p12_password || cfg.hacienda_pin || '');

  const payload: Record<string, any> = {
    name: String(cfg.emisor_name ?? '').trim(),
    identificationType: String(cfg.emisor_identification_type ?? '02'),
    identificationNumber: String(cfg.emisor_identification ?? '').replace(/\D/g, ''),
    // CRI EMITE SIEMPRE con la empresa 'main' (no hay parámetro idCompany en la
    // emisión), así que la empresa emisora del tenant DEBE crearse como 'main'.
    // (En CRI cada emisor necesita su propia cuenta/token de Alanube.)
    // Se puede forzar 'associated' con cfg.alanube_company_type === 'associated'.
    type: (cfg.alanube_company_type === 'associated' ? 'associated' : 'main'),
    address: {
      province: String(cfg.emisor_province_code ?? '').trim(),
      canton: String(cfg.emisor_canton_code ?? '').trim(),
      district: String(cfg.emisor_district_code ?? '').trim(),
      otrasSenas: others,
    },
    // Certificado de firma (.p12) — clave criptográfica + su PIN/contraseña.
    certificate: {
      extension: 'p12',
      content: p12Base64,
      password: p12Pass,
    },
    // Credenciales del token de Hacienda generadas en ATV (por ambiente).
    token: {
      username: atvUser,
      password: atvPass,
    },
  };
  if (cfg.emisor_commercial_name) payload.tradeName = String(cfg.emisor_commercial_name).trim();
  if (activity) payload.economicActivities = [activity];
  if (email) payload.emails = [email];
  if (phone) payload.phone = { countryCode: '506', phoneNumber: phone };

  // Webhook de RECEPCIÓN: Alanube nos avisa cuando un proveedor emite un
  // comprobante hacia esta cédula, y lo guardamos en la bandeja.
  const apiBase = String(process.env.PUBLIC_API_URL ?? process.env.BACKEND_URL ?? '').replace(/\/+$/, '');
  const whSecret = String(process.env.ALANUBE_WEBHOOK_SECRET ?? '').trim();
  if (apiBase && whSecret) {
    payload.webhooks = {
      documents: {
        reception: {
          status: 'active',
          url: `${apiBase}/webhooks/alanube`,
          headers: { 'x-api-key': whSecret },
        },
      },
    };
  }
  return payload;
}

// Busca el id de la empresa en la respuesta de Alanube (rutas comunes + escaneo).
function findCompanyId(result: any): string | null {
  if (!result || typeof result !== 'object') return null;
  const direct = result.id ?? result.companyId ?? result.company?.id
    ?? result.data?.id ?? result.data?.companyId ?? result.data?.company?.id ?? result._id;
  if (direct) return String(direct);
  // Escaneo en profundidad: primera clave id/_id/*Id con valor string/number.
  const seen = new Set<any>();
  const walk = (o: any): string | null => {
    if (!o || typeof o !== 'object' || seen.has(o)) return null;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      if (/(^id$|_id$|Id$)/.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length >= 6) {
        return String(v);
      }
    }
    for (const v of Object.values(o)) { const r = walk(v); if (r) return r; }
    return null;
  };
  return walk(result);
}

// POST /tenants/:id/alanube/company — crea/da de alta la empresa en Alanube.
admin.post('/tenants/:id/alanube/company', async (c) => {
  const { id } = c.req.param();
  try {
    const { data: row } = await db.from('settings').select('config')
      .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const cfg: Record<string, any> = { ...((row as any)?.config ?? {}) };

    // Validaciones mínimas antes de llamar a Alanube.
    if (!cfg.emisor_name) return fail(c, 'Falta el nombre del emisor (Datos de FE).', 422);
    if (!cfg.emisor_identification) return fail(c, 'Falta la identificación del emisor.', 422);
    // Usuario ATV: acepta el del ambiente elegido o el legacy.
    const prodEnv = String(cfg.environment ?? 'production') !== 'sandbox';
    const cert = resolveCert(cfg);
    if (!cert) return fail(c, `Falta subir el certificado .p12 de ${prodEnv ? 'Producción' : 'QA/Sandbox'} (Datos de FE).`, 422);
    const atvUserSet = (prodEnv ? cfg.atv_username_production : cfg.atv_username_sandbox) ?? cfg.atv_username;
    if (!atvUserSet) return fail(c, `Falta el usuario de API de ATV para ${prodEnv ? 'Producción' : 'QA/Sandbox'} (Datos de FE).`, 422);

    // Bajar el .p12 de Storage y pasarlo a base64 (sin prefijo data:).
    const { data: file, error: dlErr } = await db.storage.from(FE_CERT_BUCKET).download(cert.path);
    if (dlErr || !file) return fail(c, `No se pudo leer el certificado del Storage: ${dlErr?.message ?? 'vacío'}`, 500);
    const p12Base64 = Buffer.from(await file.arrayBuffer()).toString('base64');

    // Ambiente del TENANT (producción o QA/sandbox según su config FE).
    const client = alanube.forEnv(cfg.environment);
    const payload = buildAlanubeCompanyPayload(cfg, p12Base64, client.env);
    const result: any = await client.createCompany(payload);

    // Guardar el id de la empresa devuelto por Alanube para emitir después.
    // Buscamos en las rutas comunes y, si no, escaneamos en profundidad cualquier
    // clave `id`/`*Id`/`_id` con valor string (el nombre exacto varía por país).
    const companyId = findCompanyId(result);
    cfg.alanube_env = client.env;
    cfg.alanube_registered_at = new Date().toISOString();
    cfg.alanube_company_raw = result;   // respuesta cruda (para depurar el nombre del id)
    if (companyId) {
      cfg.alanube_company_id = companyId;   // legacy/compat
      // Guardar en el campo del ambiente donde se creó (producción vs sandbox).
      if (client.env === 'sandbox') cfg.alanube_company_id_sandbox = companyId;
      else cfg.alanube_company_id_production = companyId;
    }
    await db.from('settings').upsert({
      tenant_id: id, type: 'electronic-invoice', config: cfg, updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' });
    return ok(c, { ok: true, company_id: companyId, env: client.env, result });
  } catch (err: any) {
    const status = err instanceof AlanubeError ? err.status : 500;
    return fail(c, err.message, status);
  }
});

// PUT /tenants/:id/alanube/company — actualiza la empresa en Alanube (ej. para
// activar el webhook de recepción sin volver a registrarla).
admin.put('/tenants/:id/alanube/company', async (c) => {
  const { id } = c.req.param();
  try {
    const { data: row } = await db.from('settings').select('config')
      .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const cfg: Record<string, any> = { ...((row as any)?.config ?? {}) };
    // ID de empresa SEGÚN AMBIENTE (con fallback al legacy).
    const isSandbox = String(cfg.environment ?? 'production') === 'sandbox';
    const companyId = (isSandbox ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id;
    if (!companyId) return fail(c, `La empresa no está registrada en Alanube (${isSandbox ? 'QA/Sandbox' : 'Producción'}) todavía. Usá «Crear empresa».`, 422);
    const cert = resolveCert(cfg);
    if (!cert) return fail(c, `Falta el certificado .p12 de ${isSandbox ? 'QA/Sandbox' : 'Producción'} (Datos de FE).`, 422);

    const { data: file, error: dlErr } = await db.storage.from(FE_CERT_BUCKET).download(cert.path);
    if (dlErr || !file) return fail(c, `No se pudo leer el certificado del Storage: ${dlErr?.message ?? 'vacío'}`, 500);
    const p12Base64 = Buffer.from(await file.arrayBuffer()).toString('base64');

    const client = alanube.forEnv(cfg.environment);
    const payload = buildAlanubeCompanyPayload(cfg, p12Base64, client.env);
    // Al ACTUALIZAR, Alanube no acepta `type` (solo se define al crear).
    delete (payload as any).type;
    const result: any = await client.updateCompany(String(companyId), payload);

    cfg.alanube_updated_at = new Date().toISOString();
    cfg.alanube_webhook_active = !!payload.webhooks;
    await db.from('settings').upsert({
      tenant_id: id, type: 'electronic-invoice', config: cfg, updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' });
    return ok(c, { ok: true, company_id: companyId, webhook_active: !!payload.webhooks, result });
  } catch (err: any) {
    const status = err instanceof AlanubeError ? err.status : 500;
    return fail(c, err.message, status);
  }
});

// GET /tenants/:id/products — preview de los productos de un tenant (para revisar
// la carga por Excel desde el panel admin). Incluye nombres de categoría/unidad/proveedor.
admin.get('/tenants/:id/products', async (c) => {
  try {
    const { id } = c.req.param();
    const { data: prods, error } = await db.from('products')
      .select('id, name, sku, sku2, unit_price, cost_price, stock_quantity, tracks_stock, cabys_code, iva_rate, category_id, unit_type_id, supplier_id, created_at')
      .eq('tenant_id', id).order('created_at', { ascending: false }).limit(3000);
    if (error) throw new Error(error.message);
    const rows = (prods as any[]) ?? [];

    // Resolver nombres de categoría / unidad / proveedor.
    const catIds = [...new Set(rows.map(r => r.category_id).filter(Boolean))];
    const unitIds = [...new Set(rows.map(r => r.unit_type_id).filter(Boolean))];
    const supIds = [...new Set(rows.map(r => r.supplier_id).filter(Boolean))];
    const nameMap = async (table: string, ids: string[]) => {
      const map = new Map<string, string>();
      if (ids.length) {
        const { data } = await db.from(table).select('id, name').in('id', ids);
        for (const x of (data as any[]) ?? []) map.set(x.id, x.name);
      }
      return map;
    };
    const [cats, units, sups] = await Promise.all([
      nameMap('product_categories', catIds), nameMap('unit_types', unitIds), nameMap('suppliers', supIds),
    ]);

    const products = rows.map(r => ({
      id: r.id, name: r.name, sku: r.sku, sku2: r.sku2,
      unit_price: r.unit_price, cost_price: r.cost_price,
      stock_quantity: r.stock_quantity, tracks_stock: r.tracks_stock,
      cabys_code: r.cabys_code, iva_rate: r.iva_rate,
      category: r.category_id ? cats.get(r.category_id) ?? null : null,
      unit_type: r.unit_type_id ? units.get(r.unit_type_id) ?? null : null,
      supplier: r.supplier_id ? sups.get(r.supplier_id) ?? null : null,
      created_at: r.created_at,
    }));
    return ok(c, { products, count: products.length });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /tenants/:id/products-import — importa productos por Excel para un tenant
// (desde el panel admin). Resuelve/crea categorías y unidades por nombre y crea
// los productos con el service-role. body: { rows: [...] }.
admin.post('/tenants/:id/products-import', async (c) => {
  try {
    const { id } = c.req.param();
    const { rows } = await c.req.json().catch(() => ({ rows: [] }));
    if (!Array.isArray(rows) || rows.length === 0) return fail(c, 'No hay filas para importar', 422);

    const norm = (s: any) => String(s ?? '').trim().toLowerCase();
    const catMap = new Map<string, string>();
    const unitMap = new Map<string, string>();
    const supMap = new Map<string, string>();
    const { data: cats } = await db.from('product_categories').select('id, name').eq('tenant_id', id);
    for (const ct of (cats as any[]) ?? []) catMap.set(norm(ct.name), ct.id);
    const { data: units } = await db.from('unit_types').select('id, name, abbreviation').eq('tenant_id', id);
    for (const u of (units as any[]) ?? []) {
      unitMap.set(norm(u.name), u.id);
      if (u.abbreviation) unitMap.set(norm(u.abbreviation), u.id);
    }
    const { data: sups } = await db.from('suppliers').select('id, name').eq('tenant_id', id);
    for (const s of (sups as any[]) ?? []) supMap.set(norm(s.name), s.id);
    // ¿La tabla products tiene columna supplier_id? (probe — si no, solo creamos
    // el proveedor en la lista, sin vincularlo al producto).
    const probe = await db.from('products').select('supplier_id').limit(1);
    const hasSupplierCol = !probe.error;

    const resolveCat = async (raw: any): Promise<string | null> => {
      const key = norm(raw); if (!key) return null;
      if (catMap.has(key)) return catMap.get(key)!;
      const { data } = await db.from('product_categories').insert({ tenant_id: id, name: String(raw).trim() }).select('id').single();
      if ((data as any)?.id) { catMap.set(key, (data as any).id); return (data as any).id; }
      return null;
    };
    const resolveUnit = async (raw: any): Promise<string | null> => {
      const key = norm(raw); if (!key) return null;
      if (unitMap.has(key)) return unitMap.get(key)!;
      const { data } = await db.from('unit_types')
        .insert({ tenant_id: id, name: String(raw).trim(), abbreviation: String(raw).trim().slice(0, 4).toLowerCase() })
        .select('id').single();
      if ((data as any)?.id) { unitMap.set(key, (data as any).id); return (data as any).id; }
      return null;
    };
    const resolveSupplier = async (raw: any): Promise<string | null> => {
      const key = norm(raw); if (!key) return null;
      if (supMap.has(key)) return supMap.get(key)!;
      const { data } = await db.from('suppliers').insert({ tenant_id: id, name: String(raw).trim() }).select('id').single();
      if ((data as any)?.id) { supMap.set(key, (data as any).id); return (data as any).id; }
      return null;
    };

    let created = 0, errors = 0;
    let firstError: string | null = null;

    // 1) Resolver categoría/unidad/proveedor y construir los objetos de producto.
    const toInsert: Record<string, any>[] = [];
    for (const r of rows) {
      if (!r?.name) { errors++; firstError = firstError ?? 'Fila sin nombre'; continue; }
      const category_id = await resolveCat(r.category);
      const unit_type_id = await resolveUnit(r.unit_type);
      const supplier_id = await resolveSupplier(r.supplier);
      const minStock = Math.max(0, Math.round(Number(r.min_stock_level) || 0));
      let maxStock = Math.max(0, Math.round(Number(r.max_stock_level) || 0));
      if (maxStock < minStock) maxStock = minStock;   // evita violar max>=min
      if (maxStock === 0) maxStock = Math.max(minStock, 100);
      toInsert.push({
        tenant_id: id,
        name: String(r.name).trim(),
        sku: r.sku ? String(r.sku) : '',
        sku2: r.sku2 ? String(r.sku2) : null,
        description: r.description ?? null,
        unit_price: Number(r.unit_price) || 0,
        cost_price: Number(r.cost_price) || 0,
        stock_quantity: Math.max(0, Math.round(Number(r.stock_quantity) || 0)),
        min_stock_level: minStock,
        max_stock_level: maxStock,
        tracks_stock: r.tracks_stock !== false,
        category_id, unit_type_id,
        cabys_code: r.cabys_code ? String(r.cabys_code) : null,
        iva_rate: r.iva_rate ?? 13,
        ...(hasSupplierCol && supplier_id ? { supplier_id } : {}),
      });
    }

    // 2) Insertar por LOTE (rápido). Si un lote falla, caemos a fila-por-fila
    // para contar exactamente cuántos entraron y capturar el error real.
    const CHUNK = 200;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const batch = toInsert.slice(i, i + CHUNK);
      const { error } = await db.from('products').insert(batch);
      if (!error) { created += batch.length; continue; }
      for (const row of batch) {
        const { error: e2 } = await db.from('products').insert(row);
        if (e2) { errors++; firstError = firstError ?? e2.message; } else created++;
      }
    }
    return ok(c, { created, errors, error_detail: firstError });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /tenants/:id/fe-renew — renovar la bolsa de comprobantes FE (cuando el
// cliente paga). Reinicia fe_quota_start a HOY → el contador vuelve a 0 y el
// tenant recupera la cantidad incluida completa.
admin.post('/tenants/:id/fe-renew', async (c) => {
  try {
    const { id } = c.req.param();
    const { data: row } = await db.from('settings')
      .select('config').eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const cfg = { ...((row as any)?.config ?? {}), fe_quota_start: new Date().toISOString() };
    await db.from('settings').upsert({
      tenant_id: id, type: 'electronic-invoice', config: cfg,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' });
    return ok(c, { ok: true, fe_quota_start: cfg.fe_quota_start });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── Usuarios por empresa (super-admin) ─────────────────────────────────────────
const VALID_ROLES = [
  'admin', 'gerente', 'asistente_1', 'asistente_2', 'asistente_3',
  'cocinero', 'mesero', 'cajero', 'almacenero', 'contador', 'repartidor',
] as const;

// GET /tenants/:id/users — lista de usuarios de una empresa.
admin.get('/tenants/:id/users', async (c) => {
  try {
    const { id } = c.req.param();
    const { data, error } = await db.from('users')
      .select('id, full_name, email, role, phone, ticket_alias, created_at')
      .eq('tenant_id', id)
      .order('full_name');
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /tenants/:id/users — crear un usuario en una empresa (bypass de acceso: es super-admin).
admin.post('/tenants/:id/users', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const email = String(body?.email ?? '').trim();
    const password = String(body?.password ?? '');
    const full_name = String(body?.full_name ?? '').trim();
    const role = String(body?.role ?? 'cajero');
    const phone = body?.phone ? String(body.phone) : null;
    const ticket_alias = body?.ticket_alias ? String(body.ticket_alias).slice(0, 60) : null;
    if (!email || !full_name) return fail(c, 'Faltan email/usuario o nombre', 422);
    if (password.length < 6) return fail(c, 'La contraseña debe tener al menos 6 caracteres', 422);
    if (!(VALID_ROLES as readonly string[]).includes(role)) return fail(c, 'Rol inválido', 422);

    const emailLc = email.toLowerCase();
    const { data: dup } = await db.from('users').select('id').ilike('email', emailLc).maybeSingle();
    if (dup) {
      const display = emailLc.endsWith('@nexoerp.local') ? emailLc.replace('@nexoerp.local', '') : emailLc;
      return fail(c, `Ya existe un usuario con el nombre "${display}".`, 409);
    }

    const { data: authData, error: authError } = await db.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    if (!authData.user) throw new Error('No se pudo crear el usuario');

    const { data: userData, error: userError } = await db.from('users')
      .insert({ id: authData.user.id, email, full_name, role, phone, ticket_alias, tenant_id: id })
      .select('id, full_name, email, role, phone, ticket_alias, created_at')
      .single();
    if (userError) {
      await db.auth.admin.deleteUser(authData.user.id);
      throw new Error(userError.message);
    }
    await db.from('user_tenants').upsert({
      user_id: authData.user.id, tenant_id: id, role: 'staff', is_default: true,
    }, { onConflict: 'user_id,tenant_id' });

    return ok(c, userData, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PATCH /tenants/:id/users/:uid — ajustar nombre/rol/alias de un usuario de la empresa.
admin.patch('/tenants/:id/users/:uid', async (c) => {
  try {
    const { id, uid } = c.req.param();
    const body = await c.req.json();
    const patch: Record<string, any> = {};
    if (body.full_name !== undefined) patch.full_name = String(body.full_name).trim();
    if (body.role !== undefined) {
      if (!(VALID_ROLES as readonly string[]).includes(String(body.role))) return fail(c, 'Rol inválido', 422);
      patch.role = body.role;
    }
    if (body.phone !== undefined) patch.phone = body.phone || null;
    if (body.ticket_alias !== undefined) patch.ticket_alias = body.ticket_alias ? String(body.ticket_alias).slice(0, 60) : null;
    const { data, error } = await db.from('users')
      .update(patch).eq('id', uid).eq('tenant_id', id)
      .select('id, full_name, email, role, phone, ticket_alias, created_at').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /fe-quotas — resumen de la bolsa de comprobantes FE por negocio (para el
// panel admin). Devuelve { [tenantId]: { included, used, available, quota_start,
// expires_at } }. Vencimiento = inicio de la bolsa + 1 año.
admin.get('/fe-quotas', async (c) => {
  try {
    const { data: rows } = await db.from('settings')
      .select('tenant_id, config').eq('type', 'electronic-invoice');
    const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    const result: Record<string, any> = {};
    for (const r of (rows ?? []) as any[]) {
      const cfg = r.config ?? {};
      const included = Number(cfg.fe_included_docs ?? 0);
      if (included <= 0) {
        // FE activa pero sin límite de bolsa → ilimitado. Si ni siquiera está
        // activa, no devolvemos nada (el panel muestra "Sin FE").
        if (cfg.enabled) result[r.tenant_id] = { unlimited: true };
        continue;
      }
      let start: string = cfg.fe_quota_start ?? '';
      if (!start) {
        const { data: t } = await db.from('tenants')
          .select('created_at, subscription:subscriptions!tenants_subscription_id_fkey(started_at)')
          .eq('id', r.tenant_id).maybeSingle();
        start = (t as any)?.subscription?.started_at ?? (t as any)?.created_at ?? new Date().toISOString();
      }
      const [{ count: docs }, { count: ncs }] = await Promise.all([
        db.from('invoices').select('id', { count: 'exact', head: true })
          .eq('tenant_id', r.tenant_id).not('fe_clave', 'is', null).gte('created_at', start),
        db.from('invoices').select('id', { count: 'exact', head: true })
          .eq('tenant_id', r.tenant_id).not('fe_nc_clave', 'is', null).gte('created_at', start),
      ]);
      const used = (docs ?? 0) + (ncs ?? 0);
      const extraFee = Number(cfg.fe_extra_fee ?? 0);          // ₡ por comprobante extra (del plan)
      const overage = Math.max(0, used - included);            // comprobantes sobre la bolsa
      result[r.tenant_id] = {
        included, used, available: included - used,
        overage, extra_fee: extraFee, extra_charge: overage * extraFee,
        quota_start: start,
        expires_at: new Date(new Date(start).getTime() + YEAR_MS).toISOString(),
      };
    }
    return ok(c, result);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── Módulos personalizados por empresa (override sobre el plan base) ───────────
// GET /tenants/:id/features → { base: plan.features, overrides: settings }.
admin.get('/tenants/:id/features', async (c) => {
  try {
    const { id } = c.req.param();
    // Features del plan vigente (base).
    const { data: sub } = await db.from('subscriptions')
      .select('plan_id')
      .eq('tenant_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    let base: Record<string, any> = {};
    if ((sub as any)?.plan_id) {
      const { data: plan } = await db.from('subscription_plans')
        .select('features').eq('id', (sub as any).plan_id).maybeSingle();
      base = ((plan as any)?.features && typeof (plan as any).features === 'object') ? (plan as any).features : {};
    }
    // Overrides por tenant.
    const { data: ovRow } = await db.from('settings')
      .select('config').eq('tenant_id', id).eq('type', 'feature-overrides').maybeSingle();
    const overrides = (ovRow as any)?.config ?? {};
    return ok(c, { base, overrides });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /tenants/:id/feature-overrides → guarda los overrides (solo las diferencias).
admin.put('/tenants/:id/feature-overrides', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const overrides = (body?.overrides && typeof body.overrides === 'object') ? body.overrides : {};
    const { error } = await db.from('settings').upsert({
      tenant_id: id, type: 'feature-overrides', config: overrides,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' });
    if (error) throw new Error(error.message);
    return ok(c, { ok: true, overrides });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /fe-log — BITÁCORA de facturas electrónicas de TODAS las empresas.
// Para monitoreo del super-admin: ver emisiones y detectar errores rápido.
// Filtros: ?tenant_id= (una empresa) · ?search= (cliente/consecutivo/clave/factura)
//          · ?from= ?to= (fecha) · ?status= (error/accepted/sent/rejected)
admin.get('/fe-log', async (c) => {
  try {
    const tenantId = c.req.query('tenant_id');
    const search = (c.req.query('search') || '').trim();
    const from = c.req.query('from');
    const to = c.req.query('to');
    const status = c.req.query('status');
    const limit = Math.min(Number(c.req.query('limit') || 500), 2000);

    let q = db.from('invoices')
      .select('id, tenant_id, invoice_number, customer_name, total, issued_at, created_at, document_type, fe_clave, fe_consecutivo, fe_status, fe_error, fe_request, fe_response')
      .not('fe_status', 'is', null)                 // solo comprobantes electrónicos
      .order('created_at', { ascending: false })
      .limit(limit);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    if (status)   q = q.eq('fe_status', status);
    if (from)     q = q.gte('created_at', from);
    if (to)       q = q.lte('created_at', endOfDay(to));
    if (search) {
      const s = search.replace(/[%,]/g, ' ');
      q = q.or(`customer_name.ilike.%${s}%,fe_consecutivo.ilike.%${s}%,fe_clave.ilike.%${s}%,invoice_number.ilike.%${s}%`);
    }
    const res = await q;
    let data: any = res.data;
    let error: any = res.error;
    // Si las columnas fe_request/fe_response aún no existen (migración 55 sin correr),
    // reintenta sin ellas.
    if (error && /fe_request|fe_response/.test(error.message)) {
      let q2 = db.from('invoices')
        .select('id, tenant_id, invoice_number, customer_name, total, issued_at, created_at, document_type, fe_clave, fe_consecutivo, fe_status, fe_error')
        .not('fe_status', 'is', null)
        .order('created_at', { ascending: false }).limit(limit);
      if (tenantId) q2 = q2.eq('tenant_id', tenantId);
      if (status)   q2 = q2.eq('fe_status', status);
      if (from)     q2 = q2.gte('created_at', from);
      if (to)       q2 = q2.lte('created_at', endOfDay(to));
      if (search) { const s = search.replace(/[%,]/g, ' '); q2 = q2.or(`customer_name.ilike.%${s}%,fe_consecutivo.ilike.%${s}%,fe_clave.ilike.%${s}%,invoice_number.ilike.%${s}%`); }
      const res2 = await q2;
      data = res2.data; error = res2.error;
    }
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as any[];

    // Nombre del negocio (empresa) por tenant.
    const tenantIds = [...new Set(rows.map(r => r.tenant_id))];
    const nameById = new Map<string, string>();
    if (tenantIds.length) {
      const { data: ts } = await db.from('tenants').select('id, name').in('id', tenantIds);
      for (const t of (ts ?? []) as any[]) nameById.set(t.id, t.name);
    }
    // Contadores rápidos.
    const errors = rows.filter(r => String(r.fe_status).toLowerCase() === 'error').length;
    return ok(c, {
      count: rows.length, errors,
      rows: rows.map(r => ({ ...r, business_name: nameById.get(r.tenant_id) ?? '—' })),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /reception-log — BITÁCORA de comprobantes RECIBIDOS (recepción) de todas
// las empresas: proveedor, total y estado de aceptación ante Hacienda.
// Filtros: ?tenant_id= · ?search= (proveedor/clave) · ?from= ?to= · ?status= (accepted/rejected/pending)
admin.get('/reception-log', async (c) => {
  try {
    const tenantId = c.req.query('tenant_id');
    const search = (c.req.query('search') || '').trim();
    const from = c.req.query('from');
    const to = c.req.query('to');
    const status = c.req.query('status');
    const limit = Math.min(Number(c.req.query('limit') || 500), 2000);

    let q = db.from('received_documents')
      .select('id, tenant_id, clave, issuer_name, issuer_id, document_type, doc_date, total, tax, ack_status, source, purchase_id, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    if (status)   q = q.eq('ack_status', status);
    if (from)     q = q.gte('created_at', from);
    if (to)       q = q.lte('created_at', endOfDay(to));
    if (search) {
      const s = search.replace(/[%,]/g, ' ');
      q = q.or(`issuer_name.ilike.%${s}%,issuer_id.ilike.%${s}%,clave.ilike.%${s}%`);
    }
    const { data, error } = await q;
    if (error) {
      if (/received_documents/.test(error.message)) return ok(c, { count: 0, accepted: 0, rejected: 0, pending: 0, rows: [] });
      throw new Error(error.message);
    }
    const rows = (data ?? []) as any[];

    const tenantIds = [...new Set(rows.map(r => r.tenant_id))];
    const nameById = new Map<string, string>();
    if (tenantIds.length) {
      const { data: ts } = await db.from('tenants').select('id, name').in('id', tenantIds);
      for (const t of (ts ?? []) as any[]) nameById.set(t.id, t.name);
    }
    const st = (s: any) => String(s ?? '').toLowerCase();
    const accepted = rows.filter(r => st(r.ack_status).includes('accept') || r.ack_status === '1').length;
    const rejected = rows.filter(r => st(r.ack_status).includes('reject') || r.ack_status === '3').length;
    return ok(c, {
      count: rows.length, accepted, rejected, pending: rows.length - accepted - rejected,
      rows: rows.map(r => ({ ...r, business_name: nameById.get(r.tenant_id) ?? '—' })),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default admin;
