import { Hono } from 'hono';
import { db, anonClient } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { sendEmail, paymentReceiptEmailHtml, customInvoiceEmailHtml, planFeatureLabels } from '../services/emailService.js';

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
