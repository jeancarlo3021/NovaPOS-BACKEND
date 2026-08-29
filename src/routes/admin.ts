import { Hono } from 'hono';
import { db, anonClient } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { sendEmail, paymentReceiptEmailHtml, customInvoiceEmailHtml, planFeatureLabels } from '../services/emailService.js';
import { alanube, AlanubeError, tenantAlanubeToken } from '../services/alanube.js';
import { endOfDay } from '../utils/dateRange.js';
import { whatsappEnabled, sendTemplate, normalizePhone } from '../services/whatsapp.js';
import { refreshInvoiceStatus, refreshNoteStatus, emitInvoiceCore, emitCreditNoteCore, configuredNextConsecutivo, computeFeQuota } from './hacienda.js';
import { notifyPaymentDue, businessContact } from '../services/whatsappNotify.js';
import { clearPermissionCache } from '../middleware/permissions.js';

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
    const membership: Record<string, { group_id: string; group_name: string; group_kind?: string; role: string }> = {};
    try {
      // a) Filas de tenant_group_members para nuestros tenants
      const { data: members, error: mErr } = await db.from('tenant_group_members')
        .select('tenant_id, group_id, role')
        .in('tenant_id', tenantIds);
      if (mErr) console.warn('[owners] members lookup error:', mErr.message);

      // b) Datos de los grupos involucrados
      const groupIds = Array.from(new Set((members ?? []).map((r: any) => r.group_id))).filter(Boolean);
      const groupsById: Record<string, { id: string; name: string; kind?: string }> = {};
      if (groupIds.length > 0) {
        const { data: groups, error: gErr } = await db.from('tenant_groups')
          .select('id, name, kind').in('id', groupIds);
        if (gErr) console.warn('[owners] groups lookup error:', gErr.message);
        for (const g of (groups ?? []) as Array<{ id: string; name: string; kind?: string }>) {
          groupsById[g.id] = g;
        }
      }

      // c) Indexar por tenant_id
      for (const m of (members ?? []) as Array<{ tenant_id: string; group_id: string; role: string }>) {
        const g = groupsById[m.group_id];
        membership[m.tenant_id] = {
          group_id:   m.group_id,
          group_name: g?.name ?? '(grupo sin nombre)',
          group_kind: g?.kind ?? 'branches',
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
        // La cuota del grupo solo tiene sentido en SUCURSALES. En una cartera de
        // contador cada empresa es de un cliente distinto y paga lo suyo: sumarlas
        // daría una cifra que no le corresponde cobrar a nadie.
        const groupBilling = (g?.group_id && g?.group_kind !== 'accounting')
          ? await getGroupBilling(g.group_id) : null;
        const customPrice = customPriceByTenant[o.id];
        return {
          ...o,
          group_id:      g?.group_id ?? null,
          group_name:    g?.group_name ?? null,
          group_role:    g?.role ?? null,        // 'main' | 'branch' | null
          group_kind:    g?.group_kind ?? null,  // 'branches' | 'accounting'
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
    // Mes actual en HORA COSTA RICA (UTC-6, sin horario de verano): del día 1 a las
    // 00:00 CR hasta el 1° del mes siguiente 00:00 CR. Como issued_at se guarda en
    // UTC, 00:00 CR = 06:00 UTC.
    const crNow = new Date(Date.now() - 6 * 3600 * 1000);
    const y = crNow.getUTCFullYear(), m = crNow.getUTCMonth();
    const periodStart = new Date(Date.UTC(y, m, 1, 6, 0, 0)).toISOString();
    const periodEnd   = new Date(Date.UTC(y, m + 1, 1, 6, 0, 0)).toISOString();

    // ⚠️ Paginado: Supabase devuelve máx 1000 filas por query. Con muchos
    // comprobantes en el mes se truncaba y SUBCONTABA. Traemos TODO por páginas.
    const PAGE = 1000;
    const fetchAll = async (cols: string): Promise<{ data?: any[]; error?: any }> => {
      const all: any[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db.from('invoices').select(cols)
          .gte('issued_at', periodStart).lt('issued_at', periodEnd)
          .order('id', { ascending: true }).range(from, from + PAGE - 1);
        if (error) return { error };
        const chunk = data ?? [];
        all.push(...chunk);
        if (chunk.length < PAGE) break;   // última página
      }
      return { data: all };
    };
    let sel = await fetchAll('tenant_id, status, issued_at, route_id, document_type, fe_clave, fe_status');
    // Si las columnas fe_clave/document_type no existen aún, reintenta sin ellas.
    // OJO: en ese caso NINGÚN comprobante puede contarse como electrónico (no hay
    // con qué distinguirlo) → todos los negocios saldrían con 0. Se reporta en
    // `?debug=1` para no quedarse adivinando.
    let feColumnsMissing = false;
    const firstError = sel.error?.message ?? null;
    if (sel.error && /fe_clave|document_type|fe_status/.test(sel.error.message ?? '')) {
      feColumnsMissing = true;
      sel = await fetchAll('tenant_id, status, issued_at, route_id');
    }
    if (sel.error) throw new Error(sel.error.message);

    // Un comprobante es ELECTRÓNICO solo si REALMENTE se emitió a Hacienda (tiene
    // clave) y NO fue rechazado / con error. NO basta con que el document_type sea
    // electrónico: ese campo guarda lo que el usuario SELECCIONÓ. Un electrónico
    // rechazado no es válido → cuenta como corriente (la venta igual ocurrió).
    const isElectronic = (r: any) => !!r.fe_clave && r.fe_status !== 'rejected' && r.fe_status !== 'error';

    const total: Record<string, number> = {};   // facturas del mes SIN anuladas NI distribución
    const electronic: Record<string, number> = {};
    const corriente: Record<string, number> = {};
    const distCounts: Record<string, number> = {};
    for (const row of (sel.data ?? []) as any[]) {
      if (row.status === 'cancelled') continue;   // anuladas NO cuentan
      const tid = row.tenant_id as string;
      if (row.route_id) {                         // distribución va aparte, NO en el total
        distCounts[tid] = (distCounts[tid] ?? 0) + 1;
        continue;
      }
      total[tid] = (total[tid] ?? 0) + 1;         // solo no-anuladas y no-distribución
      if (isElectronic(row)) {
        electronic[tid] = (electronic[tid] ?? 0) + 1;
      } else {
        corriente[tid] = (corriente[tid] ?? 0) + 1;
      }
    }
    const tids = new Set([...Object.keys(total), ...Object.keys(electronic), ...Object.keys(corriente), ...Object.keys(distCounts)]);
    const out = Array.from(tids).map((tenant_id) => {
      const el = electronic[tenant_id] ?? 0;
      const co = corriente[tenant_id] ?? 0;
      return {
        tenant_id,
        count: total[tenant_id] ?? 0,         // TODAS las facturas del mes (CR)
        electronic_count: el,                 // facturas/tiquetes electrónicos
        corriente_count: co,                  // tiquetes corrientes
        distribution_count: distCounts[tenant_id] ?? 0,
        period_start: periodStart, period_end: periodEnd,
      };
    });
    // ?debug=1 — por qué el conteo de ELECTRÓNICOS sale en 0. Muestra si faltan las
    // columnas FE, cuántas filas traen clave y cómo se reparten los fe_status.
    if (c.req.query('debug') === '1') {
      const rows = (sel.data ?? []) as any[];
      const statusCount: Record<string, number> = {};
      let withClave = 0, withIssuedAt = 0;
      for (const r of rows) {
        const st = r.fe_status == null ? '(null)' : String(r.fe_status);
        statusCount[st] = (statusCount[st] ?? 0) + 1;
        if (r.fe_clave) withClave++;
        if (r.issued_at) withIssuedAt++;
      }
      return ok(c, {
        counts: out,
        debug: {
          period: { start: periodStart, end: periodEnd },
          rows_in_period: rows.length,
          fe_columns_missing: feColumnsMissing,
          first_query_error: firstError,
          rows_with_fe_clave: withClave,
          rows_with_issued_at: withIssuedAt,
          fe_status_breakdown: statusCount,
          hint: feColumnsMissing
            ? 'Las columnas fe_clave/fe_status/document_type no se pudieron leer: sin ellas TODO se cuenta como corriente.'
            : withClave === 0
              ? 'Ninguna factura del mes tiene fe_clave: o no se emitió a Hacienda, o la clave no se está guardando.'
              : 'Hay comprobantes con clave; revisá fe_status_breakdown (rejected/error NO cuentan como electrónicos).',
        },
      });
    }
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

    // Al guardar los datos de Hacienda del negocio, refrescar su ficha de CLIENTE en
    // el POS del admin (cédula, nombre, correo, teléfono, ubicación, actividad) para
    // poder facturarle la suscripción con los datos correctos. No bloquea el guardado.
    let customer_synced = false;
    if (fe) {
      try { await syncTenantsToCustomers(c.get('tenantId'), id); customer_synced = true; }
      catch (e: any) { console.warn('[fe-config] sync customer:', e?.message); }
    }
    return ok(c, { ok: true, customer_synced });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── Certificado criptográfico (.p12) por empresa — Supabase Storage PRIVADO ─────
export const FE_CERT_BUCKET = 'fe-certificates';

// Certificado .p12 del ambiente activo del tenant (con fallback al legacy).
export function resolveCert(cfg: Record<string, any>): { path: string; filename?: string } | null {
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
    const client = alanube.forTenant(cfg);
    let effectiveId = companyId;
    const out: any = { environment: client.env, base_url: client.baseUrl(), company_id: companyId ?? null };

    // Sin id guardado: intentamos recuperar la empresa 'main' del token (GET /company).
    // Si aparece, la GUARDAMOS para futuras emisiones/actualizaciones.
    if (!effectiveId) {
      try {
        const main: any = await client.getMainCompany();
        const mainId = findCompanyId(main?.company ?? main?.data ?? main);
        const apiStatus = main?.company?.apiStatus ?? main?.apiStatus ?? null;
        const cedula = main?.company?.identificationNumber ?? main?.identificationNumber
          ?? main?.company?.identification?.identificationNumber ?? null;
        if (mainId) {
          cfg.alanube_env = client.env;
          if (client.env === 'sandbox') cfg.alanube_company_id_sandbox = mainId;
          else cfg.alanube_company_id_production = mainId;
          cfg.alanube_company_id = mainId;
          await db.from('settings').upsert({
            tenant_id: id, type: 'electronic-invoice', config: cfg, updated_at: new Date().toISOString(),
          }, { onConflict: 'tenant_id,type' });
          return ok(c, { ...out, company_id: mainId, exists: true, api_status: apiStatus,
            identification: cedula,
            note: `Empresa principal recuperada del token y guardada (id ${mainId}${cedula ? `, cédula ${cedula}` : ''}). Ya podés «Actualizar empresa».` });
        }
      } catch { /* la cuenta no expone /company → mensaje normal */ }
      return ok(c, { ...out, exists: false, note: 'No hay company_id guardado y el token no devolvió una empresa principal.' });
    }
    try {
      const company = await client.getCompany(String(effectiveId));
      return ok(c, { ...out, exists: true, api_status: company?.company?.apiStatus ?? company?.apiStatus ?? null });
    } catch (e: any) {
      const status = e instanceof AlanubeError ? e.status : 500;
      return ok(c, { ...out, exists: false, error: e?.message, status,
        note: status === 404 ? 'La empresa NO existe en este ambiente/cuenta. El token de emisión apunta a otra cuenta o la empresa se creó en otro ambiente.' : undefined });
    }
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /tenants/:id/fe-test — PROBAR CONEXIÓN: diagnóstico completo de FE para un
// tenant. Revisa token, empresa dada de alta y si está LISTA para emitir (apiStatus).
// Explica por qué los comprobantes se quedan en "sent" (empresa no activa / cuenta
// distinta / credenciales ATV).
admin.get('/tenants/:id/fe-test', async (c) => {
  try {
    const { id } = c.req.param();
    const { data: row } = await db.from('settings').select('config')
      .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const cfg: Record<string, any> = { ...((row as any)?.config ?? {}) };
    const enabled = !!cfg.enabled;
    const provider = cfg.fe_provider === 'alanube' ? 'alanube' : 'facturemos';
    const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];
    const add = (label: string, okv: boolean, detail?: string) => checks.push({ label, ok: okv, detail });

    add('Facturación electrónica activada', enabled, enabled ? undefined : 'Actívala en Datos de FE');

    if (provider === 'alanube') {
      const isSandbox = String(cfg.environment ?? 'production') === 'sandbox';
      const companyId = (isSandbox ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id;
      const client = alanube.forTenant(cfg);

      // 1) Token del ambiente válido.
      let tokenOk = false;
      try { await client.createCompany({}); tokenOk = true; }
      catch (e: any) { const st = e instanceof AlanubeError ? e.status : 0; tokenOk = (st === 400 || st === 422); }
      add(`Token de Alanube (${client.env})`, tokenOk, tokenOk ? 'Conexión OK' : 'Token inválido o sin permisos (401/403)');

      // 2) Empresa dada de alta.
      add('Empresa dada de alta (company_id)', !!companyId, companyId ? String(companyId) : 'Usá «Crear empresa en Alanube»');

      // 3) La empresa existe en ESA cuenta/ambiente + está lista para emitir.
      if (companyId) {
        try {
          const company: any = await client.getCompany(String(companyId));
          const apiStatus = company?.company?.apiStatus ?? company?.apiStatus ?? null;
          const st = String(apiStatus ?? '').toUpperCase();
          const ready = st.includes('ACTIVE') || st.includes('PRODUCTION') || st.includes('READY') || st === 'ON';
          add('Empresa existe en Alanube', true, `apiStatus: ${apiStatus ?? '—'}`);
          add('Empresa lista para emitir a Hacienda', ready,
            ready ? undefined : `apiStatus=${apiStatus ?? '—'}. Revisá el certificado .p12 y las credenciales ATV de la empresa en Alanube — mientras no esté activa, los comprobantes quedan en «sent».`);
        } catch (e: any) {
          const st = e instanceof AlanubeError ? e.status : 500;
          add('Empresa existe en Alanube', false,
            st === 404 ? 'La empresa NO existe en este ambiente/cuenta. El token apunta a otra cuenta o la empresa se creó en otro ambiente.' : (e?.message ?? 'error'));
        }
      }
      const allOk = checks.every(x => x.ok);
      return ok(c, { provider, environment: client.env, company_id: companyId ?? null, ok: allOk, checks });
    }

    // Facturemos.
    add('ApiKey del emisor', !!cfg.api_key_emisor, cfg.api_key_emisor ? 'Configurada' : 'Falta la ApiKey del emisor');
    return ok(c, { provider, ok: checks.every(x => x.ok), checks });
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
// Normalización de códigos de ubicación Hacienda (deben coincidir con Tributación
// o se rechaza con -37): provincia = 1 dígito (1-7), cantón/distrito = 2 dígitos.
const provDigit = (s: any) => (String(s ?? '').replace(/\D/g, '').replace(/^0+/, '') || '').slice(0, 1);
const pad2Code = (s: any) => { const d = String(s ?? '').replace(/\D/g, ''); return d ? d.padStart(2, '0').slice(-2) : ''; };

export function buildAlanubeCompanyPayload(cfg: Record<string, any>, p12Base64: string, env: 'sandbox' | 'production' = 'production') {
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
    // Mismo criterio que la validación: si no se guardó, se deduce de la cédula.
    identificationType: String(cfg.emisor_identification_type ?? '').trim()
      || inferIdType(cfg.emisor_identification) || '02',
    identificationNumber: String(cfg.emisor_identification ?? '').replace(/\D/g, ''),
    // CRI EMITE SIEMPRE con la empresa 'main' (no hay parámetro idCompany en la
    // emisión), así que la empresa emisora del tenant DEBE crearse como 'main'.
    // (En CRI cada emisor necesita su propia cuenta/token de Alanube.)
    // Se puede forzar 'associated' con cfg.alanube_company_type === 'associated'.
    type: (cfg.alanube_company_type === 'associated' ? 'associated' : 'main'),
    address: {
      province: provDigit(cfg.emisor_province_code),
      canton: pad2Code(cfg.emisor_canton_code),
      district: pad2Code(cfg.emisor_district_code),
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

// Recupera el id de la empresa del tenant en Alanube cuando no quedó guardado en
// la config. CRI NO tiene un endpoint para listar la empresa 'main', así que:
//   1) verificamos los ids que YA tengamos guardados (sandbox/producción/legacy/
//      respuesta cruda) contra GET /companies/{id} en el ambiente actual, y
//   2) como respaldo, buscamos por cédula en GET /companies/associated.
/** Cédula (solo dígitos) de una empresa devuelta por Alanube, mire donde mire. */
export function companyCedula(co: any): string {
  if (!co || typeof co !== 'object') return '';
  const direct = co.identificationNumber ?? co.identification?.identificationNumber
    ?? co.company?.identificationNumber ?? co.data?.identificationNumber;
  if (direct) return String(direct).replace(/\D/g, '');
  const seen = new Set<any>();
  const walk = (o: any): string => {
    if (!o || typeof o !== 'object' || seen.has(o)) return '';
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      if (/identificationNumber/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        return String(v).replace(/\D/g, '');
      }
    }
    for (const v of Object.values(o)) { const r = walk(v); if (r) return r; }
    return '';
  };
  return walk(co);
}

/** Empresa 'main' de la cuenta/token, con su cédula (para saber DE QUIÉN es). */
export async function getMainCompanyInfo(client: any): Promise<{ id: string | null; cedula: string; raw: any }> {
  try {
    const main: any = await client.getMainCompany?.();
    const body = main?.company ?? main?.data ?? main;
    return { id: findCompanyId(body), cedula: companyCedula(body), raw: body };
  } catch { return { id: null, cedula: '', raw: null }; }
}

export async function findExistingCompanyId(client: any, cfg: Record<string, any>): Promise<string | null> {
  const cedula = String(cfg.emisor_identification ?? '').replace(/\D/g, '');

  // 0) Empresa 'main' del token (GET /company, sin id). SOLO se adopta si su cédula
  //    es la MISMA que la de este tenant. En CRI cada cuenta/token tiene una sola
  //    empresa main: si es de OTRO emisor y la adoptáramos, la actualizaríamos con
  //    los datos de este negocio y los dos tenants quedarían apuntando al mismo id
  //    (uno de los dos emitiendo con la cédula del otro).
  try {
    const main = await getMainCompanyInfo(client);
    if (main.id && (!main.cedula || !cedula || main.cedula === cedula)) return main.id;
  } catch { /* la cuenta no expone /company o no hay main → seguir */ }

  // 1) Ids candidatos ya conocidos → verificar que existan en este ambiente.
  const candidates = [
    cfg.alanube_company_id_sandbox, cfg.alanube_company_id_production,
    cfg.alanube_company_id, findCompanyId(cfg.alanube_company_raw),
  ].filter((v, i, a) => v && a.indexOf(v) === i) as string[];
  for (const cid of candidates) {
    try {
      const co: any = await client.getCompany(String(cid));
      const body = co?.company ?? co;
      const found = findCompanyId(body);
      const ced = companyCedula(body);
      // Mismo control que arriba: no adoptar la empresa de otro emisor.
      if (found && (!ced || !cedula || ced === cedula)) return found;
    } catch { /* no existe en este ambiente → seguir */ }
  }

  // 2) Respaldo: buscar por cédula entre las empresas asociadas.
  try {
    const list: any = await client.getAssociated(100);
    const arr: any[] = Array.isArray(list) ? list
      : (list?.data ?? list?.companies ?? list?.results ?? list?.rows ?? []);
    const co = (arr ?? []).find((x: any) =>
      String(x?.identificationNumber ?? x?.identification?.identificationNumber ?? '').replace(/\D/g, '') === cedula
    );
    if (co) return findCompanyId(co);
  } catch { /* sin lista de asociadas */ }

  return null;
}

// Valida los datos del emisor ANTES de llamar a Alanube y devuelve una lista de
// problemas legibles (para saber qué campo corregir en Datos de FE).
/** Tipo de identificación deducido de la longitud de la cédula (CR). */
export function inferIdType(identification: any): string {
  const d = String(identification ?? '').replace(/\D/g, '');
  if (d.length === 9) return '01';    // física
  if (d.length === 10) return '02';   // jurídica
  if (d.length === 11 || d.length === 12) return '03';   // DIMEX
  return '';
}

export function validateEmisorForAlanube(cfg: Record<string, any>, env: 'sandbox' | 'production'): string[] {
  const p: string[] = [];
  const prod = env === 'production';

  if (!String(cfg.emisor_name ?? '').trim()) p.push('Nombre del emisor: vacío.');

  // Tipo de identificación. Si nunca se guardó (el <select> lo mostraba por defecto
  // pero no lo persistía), se DEDUCE de la longitud de la cédula en vez de bloquear:
  // 9 = física, 10 = jurídica, 11-12 = DIMEX.
  const idType = String(cfg.emisor_identification_type ?? '').trim() || inferIdType(cfg.emisor_identification);
  if (!['01', '02', '03', '04'].includes(idType))
    p.push(`Tipo de identificación inválido ("${idType || 'vacío'}"): debe ser 01 (física), 02 (jurídica), 03 (DIMEX) o 04 (NITE).`);
  const ced = String(cfg.emisor_identification ?? '').replace(/\D/g, '');
  if (!ced) p.push('Número de identificación (cédula) del emisor: vacío.');
  else {
    const len: Record<string, number[]> = { '01': [9], '02': [10], '03': [11, 12], '04': [10] };
    if (idType && len[idType] && !len[idType].includes(ced.length))
      p.push(`Cédula "${ced}" tiene ${ced.length} dígitos, no coincide con el tipo ${idType} (física=9, jurídica=10, DIMEX=11-12, NITE=10).`);
  }

  const prov = provDigit(cfg.emisor_province_code);
  if (!prov || !/^[1-7]$/.test(String(prov))) p.push('Provincia: falta o inválida (1 a 7). Completá la dirección en Datos de FE.');
  const canton = pad2Code(cfg.emisor_canton_code);
  if (!canton || !/^\d{2}$/.test(String(canton))) p.push('Cantón: falta o inválido (2 dígitos).');
  const distr = pad2Code(cfg.emisor_district_code);
  if (!distr || !/^\d{2}$/.test(String(distr))) p.push('Distrito: falta o inválido (2 dígitos).');
  if (!String(cfg.emisor_address ?? '').trim()) p.push('Otras señas (dirección exacta): vacío.');

  if (!String(cfg.economic_activity_code ?? '').trim()) p.push('Actividad económica: vacía (código de Hacienda requerido).');

  const email = String(cfg.emisor_email ?? '').trim();
  if (!email) p.push('Correo del emisor: vacío.');
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) p.push(`Correo del emisor inválido: "${email}".`);

  const atvUser = String((prod ? cfg.atv_username_production : cfg.atv_username_sandbox) || cfg.atv_username || '').trim();
  const atvPass = String((prod ? cfg.atv_password_production : cfg.atv_password_sandbox) || cfg.atv_password || '');
  if (!atvUser) p.push(`Usuario de API de ATV (${prod ? 'Producción' : 'Sandbox'}): vacío.`);
  if (!atvPass) p.push(`Contraseña de API de ATV (${prod ? 'Producción' : 'Sandbox'}): vacía.`);

  const p12Pass = String((prod ? cfg.p12_password_production : cfg.p12_password_sandbox)
    || (prod ? cfg.hacienda_pin_production : cfg.hacienda_pin_sandbox)
    || cfg.p12_password || cfg.hacienda_pin || '');
  if (!p12Pass) p.push(`PIN/contraseña del certificado .p12 (${prod ? 'Producción' : 'Sandbox'}): vacío.`);

  return p;
}

// POST /tenants/:id/alanube/company — crea/da de alta la empresa en Alanube.
admin.post('/tenants/:id/alanube/company', async (c) => {
  const { id } = c.req.param();
  try {
    const { data: row } = await db.from('settings').select('config')
      .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const cfg: Record<string, any> = { ...((row as any)?.config ?? {}) };

    // Validación completa de los datos del emisor ANTES de llamar a Alanube.
    // Devuelve TODOS los problemas de una vez para que el usuario sepa exactamente
    // qué campo corregir en Datos de FE (esto es lo que causa el rechazo silencioso).
    const prodEnv = String(cfg.environment ?? 'production') !== 'sandbox';
    const problems = validateEmisorForAlanube(cfg, prodEnv ? 'production' : 'sandbox');
    // El certificado se valida aparte (es un archivo en Storage, no un campo del config).
    const cert = resolveCert(cfg);
    if (!cert) problems.unshift(`Certificado .p12 de ${prodEnv ? 'Producción' : 'QA/Sandbox'}: falta subirlo (Datos de FE).`);
    if (problems.length) {
      return fail(c, 'No se puede crear la empresa en Alanube — revisá estos datos en «Datos de FE»:\n• ' + problems.join('\n• '), 422);
    }

    // Bajar el .p12 de Storage y pasarlo a base64 (sin prefijo data:).
    if (!cert) return fail(c, 'Falta el certificado .p12 (Datos de FE).', 422); // ya cubierto arriba; guarda para el tipo
    const { data: file, error: dlErr } = await db.storage.from(FE_CERT_BUCKET).download(cert.path);
    if (dlErr || !file) return fail(c, `No se pudo leer el certificado del Storage: ${dlErr?.message ?? 'vacío'}`, 500);
    const p12Base64 = Buffer.from(await file.arrayBuffer()).toString('base64');

    // Ambiente del TENANT (producción o QA/sandbox según su config FE).
    const client = alanube.forTenant(cfg);
    const payload = buildAlanubeCompanyPayload(cfg, p12Base64, client.env);

    // ?debug=1 — devuelve el payload que se le manda a Alanube, SIN secretos, para
    // poder diagnosticar cuando responden "Something went wrong" sin detalle.
    if (c.req.query('debug') === '1') {
      const mask = (v: any) => (v ? `«${String(v).length} caracteres»` : '(vacío)');
      return ok(c, {
        env: client.env,
        usa_token_propio: !!tenantAlanubeToken(cfg, client.env as any),
        payload: {
          ...payload,
          certificate: payload.certificate
            ? { extension: payload.certificate.extension, content: mask(payload.certificate.content), password: mask(payload.certificate.password) }
            : null,
          token: payload.token
            ? { username: payload.token.username || '(vacío)', password: mask(payload.token.password) }
            : null,
        },
        checklist: {
          cedula: payload.identificationNumber,
          tipo_identificacion: payload.identificationType,
          tipo_empresa: payload.type,
          actividades: payload.economicActivities ?? null,
          provincia_canton_distrito: `${payload.address?.province}-${payload.address?.canton}-${payload.address?.district}`,
          otras_senas_len: String(payload.address?.otrasSenas ?? '').length,
          certificado_bytes: Buffer.from(p12Base64, 'base64').length,
          webhook: payload.webhooks ? 'configurado' : 'sin webhook (falta PUBLIC_API_URL o ALANUBE_WEBHOOK_SECRET)',
        },
      });
    }

    // Empresa ASOCIADA: la cuenta ya tiene su 'main' (otro emisor) y este negocio se
    // registra como una empresa adicional bajo el MISMO token. Es la forma de tener
    // varios emisores sin una cuenta por cada uno. La emisión le pasa `idCompany`.
    const asAssociated = cfg.alanube_company_type === 'associated';

    // En CRI cada cuenta/token solo admite UNA empresa 'main'. Si ya existe (por un
    // alta previa), Alanube responde "already has main company". En ese caso NO
    // fallamos: buscamos la empresa existente en la cuenta y la ACTUALIZAMOS con la
    // config corregida (dirección, certificado, etc.) — así «Crear empresa» es
    // idempotente y no deja al usuario trabado.
    let result: any;
    let updatedExisting = false;
    try {
      result = await client.createCompany(payload);
    } catch (e: any) {
      // Como asociada no hay conflicto con la principal: si Alanube igual se queja,
      // se reporta tal cual en vez de adoptar/pisar la empresa de otro emisor.
      if (asAssociated) throw e;
      const msg = String(e?.message ?? '');
      const alreadyMain = e instanceof AlanubeError
        && (e.status === 400 || e.status === 409)
        && /already has (a )?main company|ya tiene.*empresa|main company/i.test(msg);
      if (!alreadyMain) throw e;

      // Ya existe la 'main' en la cuenta: ubicamos su id y la actualizamos.
      //   1) Del CUERPO del error (Alanube suele devolver el id de la empresa
      //      existente en la respuesta 400/409) — verificado contra GET /companies/{id}.
      //   2) Respaldo: por ids guardados / cédula en asociadas.
      const myCedula = String(cfg.emisor_identification ?? '').replace(/\D/g, '');
      let existingId: string | null = null;
      const fromErr = findCompanyId((e as any)?.body);
      if (fromErr) {
        try {
          const co: any = await client.getCompany(String(fromErr));
          const body = co?.company ?? co;
          const ced = companyCedula(body);
          // Solo adoptamos la empresa si es de ESTA cédula (ver findExistingCompanyId).
          if (findCompanyId(body) && (!ced || !myCedula || ced === myCedula)) existingId = String(fromErr);
        } catch { /* el id del error no es válido en este ambiente */ }
      }
      if (!existingId) existingId = await findExistingCompanyId(client, cfg);

      // La cuenta YA tiene una empresa main y NO es la de este negocio: no se puede
      // seguir. Actualizarla pisaría el certificado y la cédula del otro emisor, y
      // los dos tenants quedarían con el mismo company_id.
      if (!existingId) {
        const main = await getMainCompanyInfo(client);
        if (main.id && main.cedula && myCedula && main.cedula !== myCedula) {
          const usandoPropio = !!tenantAlanubeToken(cfg, client.env as any);
          return fail(c,
            `Esta cuenta de Alanube (${client.env}) YA tiene su empresa principal registrada con la cédula `
            + `${main.cedula}, que NO es la de este negocio (${myCedula}).\n\n`
            + `En Costa Rica cada cuenta/token de Alanube admite UNA sola empresa emisora, y la emisión `
            + `usa siempre esa empresa principal. Continuar sobrescribiría los datos y el certificado del `
            + `otro emisor, y ambos negocios quedarían apuntando a la misma empresa (id ${main.id}).\n\n`
            + (usandoPropio
              ? `Este negocio YA tiene un token propio cargado en «Datos de FE», pero ese token apunta a una `
                + `cuenta que ya está ocupada por la cédula ${main.cedula}. Revisá que sea el token de la `
                + `cuenta NUEVA (la creada para este emisor), no el de la cuenta compartida.`
              : `CÓMO ARREGLARLO:\n`
                + `1) Creá una cuenta nueva en Alanube para este emisor (${myCedula}).\n`
                + `2) Copiá su token de ${client.env === 'sandbox' ? 'QA/Sandbox' : 'producción'}.\n`
                + `3) Pegalo acá mismo, en «Datos de FE» → «Token de la cuenta de Alanube» → `
                + `${client.env === 'sandbox' ? 'QA / Sandbox' : 'Producción'}, y guardá.\n`
                + `4) Volvé a darle a «Crear empresa en Alanube».\n\n`
                + `Mientras el token esté vacío se usa el del servidor, que es el de la cédula ${main.cedula}.`),
            409);
        }
      }
      if (!existingId) {
        // La cuenta ya tiene su empresa principal pero no logramos ubicar su id por
        // API (CRI no lista la 'main'). NO es un error que bloquee: la emisión usa la
        // 'main' de la cuenta automáticamente. Marcamos el tenant como registrado y
        // listo para emitir, y guardamos el cuerpo crudo del error de Alanube para
        // depurar dónde viene el id (el usuario puede pegarlo luego en Datos de FE).
        cfg.alanube_env = client.env;
        cfg.alanube_registered_at = new Date().toISOString();
        cfg.alanube_main_exists = true;
        cfg.alanube_create_error_body = (e as any)?.body ?? null;
        await db.from('settings').upsert({
          tenant_id: id, type: 'electronic-invoice', config: cfg, updated_at: new Date().toISOString(),
        }, { onConflict: 'tenant_id,type' });
        return ok(c, {
          ok: true,
          already_main: true,
          env: client.env,
          company_id: null,
          message: 'La empresa principal YA existe en esta cuenta de Alanube. Ya podés emitir '
            + 'comprobantes (la emisión usa esa empresa automáticamente). Si querés actualizar '
            + 'sus datos o activar el webhook de recepción, pegá el ID de la empresa (del panel '
            + 'de Alanube) en Datos de FE y usá «Actualizar empresa».',
          alanube_error_body: (e as any)?.body ?? null,   // diagnóstico: dónde viene el id
        });
      }

      const updPayload: Record<string, any> = { ...payload };
      delete updPayload.type;     // 'type' solo se define al crear
      result = await client.updateCompany(String(existingId), updPayload);
      if (!findCompanyId(result)) result = { ...result, id: existingId };
      updatedExisting = true;
    }

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
    return ok(c, { ok: true, company_id: companyId, env: client.env, updated_existing: updatedExisting, result });
  } catch (err: any) {
    const status = err instanceof AlanubeError ? err.status : 500;
    // El CUERPO del error de Alanube trae el detalle real (qué campo rechazó y por
    // qué). Sin esto solo se veía un mensaje genérico y no había cómo diagnosticar.
    let detail = '';
    const body = (err as any)?.body;
    if (body) {
      const parts: string[] = [];
      const walk = (v: any, depth = 0) => {
        if (depth > 4 || v == null) return;
        if (typeof v === 'string') { if (v.trim() && v.length < 300) parts.push(v.trim()); return; }
        if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
        if (typeof v === 'object') {
          for (const k of ['message', 'error', 'detail', 'details', 'errors', 'msg', 'description']) {
            if (k in v) walk((v as any)[k], depth + 1);
          }
        }
      };
      walk(body);
      const uniq = [...new Set(parts)].filter(x => x !== err.message);
      if (uniq.length) detail = '\n\nDetalle de Alanube:\n• ' + uniq.join('\n• ');
      else detail = '\n\nRespuesta cruda de Alanube:\n' + JSON.stringify(body).slice(0, 1200);
      // Pista concreta para el error más común al dar de alta una empresa: las
      // credenciales de ATV son POR CÉDULA y no son el PIN del .p12.
      if (/invalid credentials|hacienda system/i.test(JSON.stringify(body))) {
        detail += '\n\n👉 Esto NO es el token de Alanube: son las credenciales de ATV (Hacienda) del emisor.\n'
          + 'En «Datos de FE», para el ambiente activo, revisá:\n'
          + '  · Usuario de API de ATV — se genera en ATV para ESA cédula (suele terminar en @stag.comprobanteselectronicos.go.cr o .go.cr)\n'
          + '  · Contraseña de API de ATV — es la que da ATV al generar el usuario, NO el PIN del certificado .p12\n'
          + '  · Que sean las del MISMO contribuyente cuyo certificado subiste.';
      }
    }
    return fail(c, err.message + detail, status);
  }
});

// DELETE /tenants/:id/alanube/company — DA DE BAJA la empresa en Alanube.
// Sirve para liberar la cuenta cuando la empresa principal quedó registrada con la
// cédula equivocada (o con datos de otro emisor) y no hay portal de Alanube a mano.
// Después de borrarla, «Crear empresa» la crea limpia con los datos de este negocio.
// body: { confirm: "<cédula del emisor a borrar>", company_id?: "<id>" }
admin.delete('/tenants/:id/alanube/company', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({} as any));

    const { data: row } = await db.from('settings').select('config')
      .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const cfg: Record<string, any> = { ...((row as any)?.config ?? {}) };
    const client = alanube.forTenant(cfg);

    // Qué empresa se va a borrar: la indicada, o la 'main' de la cuenta/token.
    let targetId = String(body?.company_id ?? '').trim();
    let targetCed = '';
    if (targetId) {
      try {
        const co: any = await client.getCompany(targetId);
        targetCed = companyCedula(co?.company ?? co);
      } catch { /* seguimos: puede existir igual */ }
    } else {
      const main = await getMainCompanyInfo(client);
      if (!main.id) {
        return fail(c, `No se encontró ninguna empresa registrada en esta cuenta de Alanube (${client.env}). `
          + 'Si conocés el id, mandalo en company_id.', 404);
      }
      targetId = main.id;
      targetCed = main.cedula;
    }

    // Confirmación EXPLÍCITA con la cédula de la empresa que se va a borrar, para
    // no eliminar por error la empresa de otro emisor.
    const confirm = String(body?.confirm ?? '').replace(/\D/g, '');
    if (!confirm || (targetCed && confirm !== targetCed.replace(/^0+/, '') && confirm !== targetCed)) {
      return fail(c,
        `Confirmación requerida. Se va a dar de baja la empresa ${targetId}`
        + (targetCed ? ` (cédula ${targetCed})` : '')
        + ` en la cuenta de Alanube de ${client.env}.\n\n`
        + `Escribí la cédula ${targetCed || 'de la empresa'} para confirmar.`,
        422);
    }

    let deleted = false;
    let alanubeError: string | null = null;
    try {
      await client.deleteCompany(targetId);
      deleted = true;
    } catch (e: any) {
      alanubeError = e?.message ?? 'Error desconocido';
      // Si Alanube no permite borrar por API, se avisa claro en vez de mentir.
      const st = e instanceof AlanubeError ? e.status : 0;
      if (st === 404) { deleted = true; alanubeError = null; }   // ya no existía
    }

    // Limpiar SIEMPRE las referencias locales al id borrado: aunque Alanube haya
    // fallado, dejar el id apuntando a una empresa ajena es peor.
    let cleaned = false;
    for (const k of ['alanube_company_id', 'alanube_company_id_production', 'alanube_company_id_sandbox']) {
      if (cfg[k] && String(cfg[k]) === targetId) { delete cfg[k]; cleaned = true; }
    }
    if (cleaned || deleted) {
      delete cfg.alanube_main_exists;
      delete cfg.alanube_company_raw;
      await db.from('settings').upsert({
        tenant_id: id, type: 'electronic-invoice', config: cfg, updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,type' });
    }

    if (!deleted) {
      return fail(c,
        `Alanube no permitió dar de baja la empresa ${targetId}: ${alanubeError}\n\n`
        + `Es probable que su API no exponga el borrado de empresas o que la empresa ya tenga `
        + `comprobantes emitidos. Pedile la baja al soporte de Alanube indicando el id ${targetId}.`
        + (cleaned ? '\n\n(La referencia local a esa empresa SÍ se limpió en este negocio.)' : ''),
        502);
    }

    return ok(c, {
      ok: true,
      deleted_company_id: targetId,
      cedula: targetCed || null,
      env: client.env,
      local_refs_cleared: cleaned,
      message: `Empresa ${targetId} dada de baja en Alanube (${client.env}). `
        + 'Ya podés usar «Crear empresa en Alanube» para registrarla con los datos de este negocio.',
    });
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
    const cert = resolveCert(cfg);
    if (!cert) return fail(c, `Falta el certificado .p12 de ${isSandbox ? 'QA/Sandbox' : 'Producción'} (Datos de FE).`, 422);

    const { data: file, error: dlErr } = await db.storage.from(FE_CERT_BUCKET).download(cert.path);
    if (dlErr || !file) return fail(c, `No se pudo leer el certificado del Storage: ${dlErr?.message ?? 'vacío'}`, 500);
    const p12Base64 = Buffer.from(await file.arrayBuffer()).toString('base64');

    const client = alanube.forTenant(cfg);
    // Si el id no quedó guardado en la config, lo recuperamos de la cuenta de Alanube.
    let companyId = (isSandbox ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id;
    if (!companyId) {
      companyId = await findExistingCompanyId(client, cfg);
      if (!companyId) return fail(c, `La empresa no está registrada en Alanube (${isSandbox ? 'QA/Sandbox' : 'Producción'}) todavía. Usá «Crear empresa».`, 422);
      // Guardar el id recuperado para la próxima.
      if (isSandbox) cfg.alanube_company_id_sandbox = companyId; else cfg.alanube_company_id_production = companyId;
      cfg.alanube_company_id = companyId;
    }
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
      /**
       * Lo que el archivo NO trae, no se toca.
       *
       * Al reimportar, el archivo suele traer solo unas columnas —precios, por
       * ejemplo—. Si las ausentes viajaran como vacías, actualizar precios
       * BORRARÍA el CABYS, la descripción y el proveedor de todo el catálogo, y
       * con el CABYS en blanco Hacienda rechaza las facturas. Solo se manda lo
       * que viene con valor.
       */
      const traido = (v: any) => v !== undefined && v !== null && String(v).trim() !== '';
      const opcional: Record<string, any> = {};
      if (traido(r.sku2))        opcional.sku2 = String(r.sku2);
      if (traido(r.description)) opcional.description = r.description;
      if (traido(r.cabys_code))  opcional.cabys_code = String(r.cabys_code);
      if (traido(r.cost_price))  opcional.cost_price = Number(r.cost_price) || 0;
      if (traido(r.stock_quantity)) {
        opcional.stock_quantity = Math.max(0, Math.round(Number(r.stock_quantity) || 0));
      }
      if (category_id)  opcional.category_id = category_id;
      if (unit_type_id) opcional.unit_type_id = unit_type_id;
      if (hasSupplierCol && supplier_id) opcional.supplier_id = supplier_id;

      toInsert.push({
        tenant_id: id,
        name: String(r.name).trim(),
        sku: r.sku ? String(r.sku) : '',
        unit_price: Number(r.unit_price) || 0,
        min_stock_level: minStock,
        max_stock_level: maxStock,
        tracks_stock: r.tracks_stock !== false,
        iva_rate: r.iva_rate ?? 13,
        ...opcional,
      });
    }

    /**
     * 2) Guardar por LOTE, ACTUALIZANDO lo que ya existe.
     *
     * Un catálogo se importa varias veces: la primera carga, la corrección de
     * precios, el archivo del proveedor al mes siguiente. Con `insert` a secas,
     * el segundo intento moría entero —«duplicate key ... products_sku_tenant_unique»—
     * y no entraba NI UN producto, ni siquiera los nuevos: para actualizar
     * precios había que borrar el catálogo primero.
     *
     * Con `upsert` sobre (tenant_id, sku), el que ya está se actualiza y el que
     * no, se crea. El SKU es la identidad del producto; sin SKU no hay contra
     * qué comparar, así que esos van por inserción normal.
     */
    const CHUNK = 200;
    let updated = 0;

    /**
     * Se consulta qué SKU ya existen en vez de usar `upsert`.
     *
     * `upsert` necesita que el índice único de la base calce EXACTO con las
     * columnas declaradas; si está definido distinto (parcial, u otro orden),
     * falla en las 5.000 filas con un error que no dice nada útil. Preguntar qué
     * hay funciona con cualquier definición del índice, y de paso permite
     * informar por separado cuántos se crearon y cuántos se actualizaron.
     */
    const conSku = toInsert.filter(r => String(r.sku ?? '').trim() !== '');
    const sinSku = toInsert.filter(r => String(r.sku ?? '').trim() === '');

    // Mapa sku → id de lo que YA está en el catálogo del negocio.
    const idPorSku = new Map<string, string>();
    for (let i = 0; i < conSku.length; i += CHUNK) {
      const skus = conSku.slice(i, i + CHUNK).map(r => String(r.sku));
      const { data } = await db.from('products')
        .select('id, sku').eq('tenant_id', id).in('sku', skus);
      for (const p of (data ?? []) as any[]) {
        if (p.sku) idPorSku.set(String(p.sku), String(p.id));
      }
    }

    const nuevos = conSku.filter(r => !idPorSku.has(String(r.sku))).concat(sinSku);
    const existentes = conSku.filter(r => idPorSku.has(String(r.sku)));

    // Los que ya estaban: se actualizan uno por uno (cada uno con su id).
    for (const row of existentes) {
      const { tenant_id: _t, sku: _s, ...patch } = row;
      const { error } = await db.from('products')
        .update(patch).eq('id', idPorSku.get(String(row.sku))!).eq('tenant_id', id);
      if (error) { errors++; firstError = firstError ?? error.message; } else updated++;
    }

    // Los nuevos: por lote, y fila por fila solo si el lote falla, para que una
    // fila mala no se lleve puestas a las otras 199.
    for (let i = 0; i < nuevos.length; i += CHUNK) {
      const batch = nuevos.slice(i, i + CHUNK);
      const { error } = await db.from('products').insert(batch);
      if (!error) { created += batch.length; continue; }
      for (const row of batch) {
        const { error: e2 } = await db.from('products').insert(row);
        if (e2) { errors++; firstError = firstError ?? e2.message; } else created++;
      }
    }

    return ok(c, { created, updated, errors, error_detail: firstError });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /tenants/:id/fe-renew — renovar la bolsa de comprobantes FE (cuando el
// cliente paga). Reinicia fe_quota_start a HOY → el contador vuelve a 0 y el
// tenant recupera la cantidad incluida completa.
// POST /tenants/:id/reset-business — DESTRUCTIVO: deja el negocio "como nuevo"
// borrando TODOS los datos operativos (ventas, caja, CxC, compras, gastos, recibidos,
// clientes…) pero CONSERVANDO los PRODUCTOS y la configuración. Exige confirmar con
// el nombre exacto del negocio.
admin.post('/tenants/:id/reset-business', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({} as any));
    const { data: t } = await db.from('tenants').select('name').eq('id', id).maybeSingle();
    if (!t) return fail(c, 'Negocio no encontrado', 404);
    if (String(body?.confirm ?? '').trim().toLowerCase() !== String((t as any).name ?? '').trim().toLowerCase()) {
      return fail(c, 'Confirmación incorrecta: escribí el nombre exacto del negocio.', 422);
    }

    const CHUNK = 200;
    // Borra los hijos por FK (sin ON DELETE CASCADE garantizado) primero, por id del padre.
    const delChildren = async (parent: string, child: string, fk: string) => {
      try {
        const { data: parents } = await db.from(parent).select('id').eq('tenant_id', id);
        const ids = (parents ?? []).map((p: any) => p.id);
        for (let i = 0; i < ids.length; i += CHUNK) {
          await db.from(child).delete().in(fk, ids.slice(i, i + CHUNK));
        }
      } catch (e: any) { console.warn(`[reset-business] ${child}:`, e?.message); }
    };

    await delChildren('invoices', 'invoice_items', 'invoice_id');
    await delChildren('purchases', 'purchase_items', 'purchase_id');
    await delChildren('cash_sessions', 'cash_movements', 'cash_session_id');

    // Tablas con tenant_id directo. Se CONSERVAN: products, categories, unit_types,
    // suppliers, settings, users (catálogo + configuración). Cada borrado es tolerante
    // a que la tabla no exista.
    const tables = [
      'accounts_receivable_payments', 'accounts_receivable',
      'invoices', 'cash_sessions',
      'purchases', 'stock_adjustments', 'expenses',
      'received_documents', 'proformas', 'customer_prices', 'customers',
    ];
    const deleted: Record<string, boolean> = {};
    for (const tbl of tables) {
      try { await db.from(tbl).delete().eq('tenant_id', id); deleted[tbl] = true; }
      catch (e: any) { deleted[tbl] = false; console.warn(`[reset-business] ${tbl}:`, e?.message); }
    }

    return ok(c, { ok: true, tenant: (t as any).name, deleted, kept: ['products', 'categories', 'unit_types', 'suppliers', 'settings', 'users'] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /sync-customers — MIGRA los negocios del panel admin a la lista de CLIENTES
// del POS del propio admin (ColónClick), para poder facturarles la suscripción.
// Cada tenant (menos el propio) se vuelve un customer con los datos del emisor FE
// (cédula, nombre, correo, teléfono, dirección). Es IDEMPOTENTE: si el cliente ya
// existe (misma cédula, o mismo nombre cuando no hay cédula) se ACTUALIZA en vez de
// duplicarse. body opcional: { tenant_id } para migrar uno solo.
async function syncTenantsToCustomers(myTenant: string, onlyTenant: string | null) {
  {
    let q = db.from('tenants').select('id, name, owner_id');
    if (onlyTenant) q = q.eq('id', onlyTenant);
    const { data: tenants, error: tErr } = await q;
    if (tErr) throw new Error(tErr.message);
    const targets = (tenants ?? []).filter((t: any) => t.id !== myTenant);
    if (targets.length === 0) return { created: 0, updated: 0, total: 0, errors: [] as string[] };

    // Config FE de cada negocio (datos del emisor) — de ahí salen cédula/correo/dirección.
    const feByTenant: Record<string, any> = {};
    try {
      const { data: rows } = await db.from('settings')
        .select('tenant_id, config').eq('type', 'electronic-invoice')
        .in('tenant_id', targets.map((t: any) => t.id));
      for (const r of (rows ?? []) as any[]) feByTenant[r.tenant_id] = r.config ?? {};
    } catch (e: any) { console.warn('[sync-customers] fe config:', e?.message); }

    // Correo del dueño como respaldo cuando la config FE no trae correo.
    const emailByOwner: Record<string, string> = {};
    try {
      const ownerIds = targets.map((t: any) => t.owner_id).filter(Boolean);
      if (ownerIds.length > 0) {
        const { data: us } = await db.from('users').select('id, email').in('id', ownerIds);
        for (const u of (us ?? []) as any[]) if (u.email) emailByOwner[u.id] = u.email;
      }
    } catch (e: any) { console.warn('[sync-customers] owner emails:', e?.message); }

    // Clientes que ya tengo, indexados por cédula y por nombre (para no duplicar).
    const { data: existing } = await db.from('customers')
      .select('id, name, identification').eq('tenant_id', myTenant);
    const byIdent: Record<string, string> = {};
    const byName:  Record<string, string> = {};
    for (const cu of (existing ?? []) as any[]) {
      const ident = String(cu.identification ?? '').replace(/\D/g, '');
      if (ident) byIdent[ident] = cu.id;
      const n = String(cu.name ?? '').trim().toLowerCase();
      if (n) byName[n] = cu.id;
    }

    let created = 0, updated = 0;
    const errors: string[] = [];
    for (const t of targets as any[]) {
      const fe = feByTenant[t.id] ?? {};
      const ident = String(fe.emisor_identification ?? '').replace(/\D/g, '');
      const name  = String(fe.emisor_name || t.name || '').trim();
      if (!name) continue;
      const payload: Record<string, any> = {
        tenant_id:           myTenant,
        name,
        commercial_name:     fe.emisor_commercial_name || t.name || null,
        identification:      ident || null,
        identification_type: fe.emisor_identification_type || (ident ? (ident.length === 9 ? '01' : '02') : null),
        email:               fe.emisor_email || emailByOwner[t.owner_id] || null,
        phone:               fe.emisor_phone || null,
        address:             fe.emisor_address || null,
        province_code:       fe.emisor_province_code || null,
        canton_code:         fe.emisor_canton_code || null,
        district_code:       fe.emisor_district_code || null,
        economic_activity_code: fe.economic_activity_code || null,
        is_active:           true,
      };
      const existingId = (ident && byIdent[ident]) || byName[name.toLowerCase()] || null;
      try {
        if (existingId) {
          // No pisar con nulos lo que ya esté lleno.
          const patch = Object.fromEntries(Object.entries(payload).filter(([k, v]) => k !== 'tenant_id' && v != null));
          const { error } = await db.from('customers').update(patch).eq('id', existingId).eq('tenant_id', myTenant);
          if (error) throw new Error(error.message);
          updated++;
        } else {
          const { error } = await db.from('customers').insert(payload);
          if (error) throw new Error(error.message);
          created++;
          if (ident) byIdent[ident] = 'new';
          byName[name.toLowerCase()] = 'new';
        }
      } catch (e: any) { errors.push(`${name}: ${e?.message}`); }
    }

    return { created, updated, total: targets.length, errors };
  }
}

// GET /tenants/:id/hacienda-activities — consulta el PADRÓN público de Hacienda las
// actividades económicas REGISTRADAS para la cédula del emisor. Sirve para evitar el
// rechazo -407 ("El Código de la Actividad Económica del emisor … no se encuentra
// Registrado ante el Ministerio de Hacienda para este contribuyente").
// ?identificacion=<cédula> para consultar una distinta a la configurada.
admin.get('/tenants/:id/hacienda-activities', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const { id } = c.req.param();
    let ident = String(c.req.query('identificacion') ?? '').replace(/\D/g, '');
    let configured: string | null = null;
    if (!ident) {
      const { data: row } = await db.from('settings').select('config')
        .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
      const cfg = (row?.config as any) ?? {};
      ident = String(cfg.emisor_identification ?? '').replace(/\D/g, '');
      configured = String(cfg.economic_activity_code ?? '').replace(/\D/g, '') || null;
    }
    if (!ident) return fail(c, 'El negocio no tiene cédula del emisor configurada', 422);

    const url = `https://api.hacienda.go.cr/fe/ae?identificacion=${ident}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return fail(c, `Hacienda no tiene registrada la cédula ${ident}`, 404);
    if (!res.ok) return fail(c, `Hacienda respondió ${res.status} al consultar la cédula ${ident}`, 502);
    const body: any = await res.json().catch(() => ({}));

    // Solo las ACTIVAS sirven para facturar; el resto se devuelven marcadas.
    const activities = (Array.isArray(body?.actividades) ? body.actividades : []).map((a: any) => ({
      codigo:      String(a?.codigo ?? '').trim(),
      descripcion: String(a?.descripcion ?? '').trim(),
      estado:      String(a?.estado ?? '').trim(),
      tipo:        String(a?.tipo ?? '').trim(),
      activa:      /^a/i.test(String(a?.estado ?? '')),   // "A" / "Activo"
    })).filter((a: any) => a.codigo);
    const activeCodes = activities.filter((a: any) => a.activa).map((a: any) => a.codigo);

    return ok(c, {
      identificacion: ident,
      nombre:      body?.nombre ?? null,
      situacion:   body?.situacion ?? null,
      activities,
      configured,
      // ¿La actividad configurada está registrada Y activa? Esto es exactamente lo
      // que valida Hacienda al emitir (-407).
      configured_valid: configured ? activeCodes.includes(configured) : null,
      suggestion: configured && !activeCodes.includes(configured) ? (activeCodes[0] ?? null) : null,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /alanube/duplicate-companies — negocios que comparten el MISMO company_id de
// Alanube. Eso NO debería pasar (una empresa por cuenta/token) y significa que un
// alta pisó la de otro emisor: el que quedó sin su empresa emite con la cédula ajena.
// GET /fe-wrong-emisor?tenant_id= — comprobantes cuya CLAVE de Hacienda NO
// corresponde a la cédula configurada del negocio. Pasa cuando dos tenants
// compartieron la misma empresa de Alanube: se emitió con la cédula del otro.
// La clave (50 díg) lleva la cédula del emisor rellenada a 12 dígitos en las
// posiciones 9..20 (506 + DDMMAA + cedula12 + consecutivo20 + situacion + seguridad8).
admin.get('/fe-wrong-emisor', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const tenantFilter = c.req.query('tenant_id') || null;

    // Cédula configurada por tenant.
    const { data: cfgRows } = await db.from('settings')
      .select('tenant_id, config').eq('type', 'electronic-invoice');
    const cedByTenant = new Map<string, string>();
    for (const r of (cfgRows ?? []) as any[]) {
      const ced = String(r.config?.emisor_identification ?? '').replace(/\D/g, '');
      if (ced) cedByTenant.set(r.tenant_id, ced);
    }
    const { data: tenants } = await db.from('tenants').select('id, name');
    const nameById = new Map<string, string>();
    for (const t of (tenants ?? []) as any[]) nameById.set(t.id, t.name);

    let q = db.from('invoices')
      .select('id, tenant_id, invoice_number, fe_clave, fe_status, document_type, total, issued_at, customer_name')
      .not('fe_clave', 'is', null)
      .order('issued_at', { ascending: false })
      .limit(2000);
    if (tenantFilter) q = q.eq('tenant_id', tenantFilter);
    const { data: invs, error } = await q;
    if (error) throw new Error(error.message);

    const wrong: any[] = [];
    for (const inv of (invs ?? []) as any[]) {
      const clave = String(inv.fe_clave ?? '').replace(/\D/g, '');
      if (clave.length !== 50) continue;              // ids de Alanube (aún sin clave real)
      const myCed = cedByTenant.get(inv.tenant_id);
      if (!myCed) continue;                            // sin cédula configurada: nada que comparar
      const claveCed = clave.slice(9, 21).replace(/^0+/, '');   // cédula del emisor en la clave
      if (claveCed === myCed.replace(/^0+/, '')) continue;      // coincide → está bien
      wrong.push({
        invoice_id: inv.id,
        tenant_id: inv.tenant_id,
        business: nameById.get(inv.tenant_id) ?? '—',
        invoice_number: inv.invoice_number,
        document_type: inv.document_type,
        fe_status: inv.fe_status,
        total: inv.total,
        issued_at: inv.issued_at,
        customer_name: inv.customer_name,
        clave: clave,
        cedula_en_clave: claveCed,
        cedula_configurada: myCed,
        // Qué hacer con cada una.
        accion: (inv.fe_status === 'rejected' || inv.fe_status === 'error')
          ? 'RE-EMITIR: Hacienda la rechazó, no existe legalmente. Corregí los datos y usá «Re-emitir».'
          : inv.fe_status === 'accepted'
            ? 'ANULAR CON NOTA DE CRÉDITO desde el emisor de la clave y volver a emitirla desde este negocio.'
            : 'EN PROCESO: esperá el estado final antes de tocarla.',
      });
    }

    const byStatus: Record<string, number> = {};
    for (const w of wrong) byStatus[String(w.fe_status ?? 'sent')] = (byStatus[String(w.fe_status ?? 'sent')] ?? 0) + 1;

    return ok(c, {
      total: wrong.length,
      por_estado: byStatus,
      invoices: wrong,
      note: wrong.length === 0
        ? 'Ninguna factura salió con una cédula distinta a la configurada.'
        : 'Las RECHAZADAS se re-emiten sin más. Las ACEPTADAS ya existen en Hacienda a nombre de la cédula de la clave: hay que anularlas con nota de crédito DESDE ESE emisor y volver a emitirlas desde este.',
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /fe-bulk-credit-notes — anula EN LOTE las facturas aceptadas que salieron
// con la cédula equivocada (empresa de Alanube compartida). Emite una nota de
// crédito por cada una.
//
// GUARD CLAVE: Hacienda exige que quien anula sea el MISMO emisor del documento
// referenciado. Por eso solo se procesan facturas cuya clave lleve la cédula que el
// tenant tiene configurada AHORA. Si ya reconfiguraste el negocio con otra cédula,
// hay que volver a poner la anterior (con su certificado) para poder anular.
//
// body: { tenant_id, invoice_ids?: string[], confirm: "ANULAR", reason?, dry_run? }
admin.post('/fe-bulk-credit-notes', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const body = await c.req.json().catch(() => ({} as any));
    const tenantId = String(body?.tenant_id ?? '').trim();
    if (!tenantId) return fail(c, 'Falta tenant_id', 422);
    const dryRun = body?.dry_run === true;
    const reason = String(body?.reason ?? 'Anulación: comprobante emitido con datos de emisor incorrectos').slice(0, 180);

    // La NC se emite con la configuración de FE de ESTE negocio, salvo que se
    // indique `emisor_tenant_id`: el negocio que HOY tiene configurada la cédula
    // con la que salieron esas facturas. Sirve cuando el negocio original ya se
    // reconfiguró con otra cédula y la anterior vive en otro tenant.
    const emisorTenantId = String(body?.emisor_tenant_id ?? '').trim() || tenantId;
    const { data: cfgRow } = await db.from('settings').select('config')
      .eq('tenant_id', emisorTenantId).eq('type', 'electronic-invoice').maybeSingle();
    const myCed = String((cfgRow as any)?.config?.emisor_identification ?? '').replace(/\D/g, '').replace(/^0+/, '');
    if (!myCed) return fail(c, `El negocio emisor (${emisorTenantId}) no tiene cédula del emisor configurada.`, 422);

    // Candidatas: aceptadas, con clave real, sin nota de crédito previa.
    let q = db.from('invoices')
      .select('id, invoice_number, fe_clave, fe_status, fe_nc_clave, total, issued_at, customer_name')
      .eq('tenant_id', tenantId).eq('fe_status', 'accepted')
      .not('fe_clave', 'is', null).limit(2000);
    if (Array.isArray(body?.invoice_ids) && body.invoice_ids.length) q = q.in('id', body.invoice_ids);
    const { data: invs, error } = await q;
    if (error) throw new Error(error.message);

    const eligible: any[] = [];
    const skipped: any[] = [];
    for (const inv of (invs ?? []) as any[]) {
      const clave = String(inv.fe_clave ?? '').replace(/\D/g, '');
      const base = { invoice_id: inv.id, invoice_number: inv.invoice_number, total: inv.total, customer_name: inv.customer_name };
      if (clave.length !== 50) { skipped.push({ ...base, motivo: 'Sin clave de Hacienda válida (50 díg).' }); continue; }
      if (inv.fe_nc_clave)     { skipped.push({ ...base, motivo: 'Ya tiene nota de crédito.' }); continue; }
      const claveCed = clave.slice(9, 21).replace(/^0+/, '');
      if (claveCed !== myCed) {
        skipped.push({ ...base, motivo: `La clave es del emisor ${claveCed}, pero el emisor usado para anular está configurado como ${myCed}. `
          + 'Hacienda solo acepta la anulación desde el emisor original: pasá en emisor_tenant_id el negocio que hoy tiene la cédula '
          + `${claveCed} (con su certificado y su cuenta de Alanube), o reconfigurala temporalmente acá.` });
        continue;
      }
      eligible.push({ ...base, clave });
    }

    // dry_run o sin confirmar: se devuelve la previsualización SIN emitir nada.
    if (dryRun || String(body?.confirm ?? '') !== 'ANULAR') {
      return ok(c, {
        dry_run: true,
        emisor_tenant_id: emisorTenantId,
        cedula_configurada: myCed,
        elegibles: eligible.length, omitidas: skipped.length,
        total_a_anular: eligible.reduce((s, e) => s + Number(e.total ?? 0), 0),
        eligible, skipped,
        note: 'Nada se emitió. Para ejecutar, repetí el llamado con confirm: "ANULAR". '
          + 'Si las facturas salieron con una cédula que hoy está configurada en OTRO negocio, '
          + 'pasá su id en emisor_tenant_id para emitir las NC desde ahí.',
      });
    }

    const results: any[] = [];
    for (const e of eligible) {
      try {
        // OJO: la NC se emite con la config del emisor, pero la factura vive en el
        // tenant original. Si son distintos, se emite temporalmente "como" el emisor.
        const res: any = await emitCreditNoteCore(c, emisorTenantId, e.invoice_id, reason);
        // emitCreditNoteCore devuelve una Response de Hono: leemos su cuerpo.
        const parsed = await res.clone().json().catch(() => null);
        const okRes = !!parsed?.data && !parsed?.error;
        results.push({ ...e, ok: okRes, nc_clave: parsed?.data?.nc_clave ?? null, error: parsed?.error ?? null });
      } catch (err: any) {
        results.push({ ...e, ok: false, error: err?.message ?? 'Error desconocido' });
      }
    }

    const okCount = results.filter(r => r.ok).length;
    return ok(c, {
      dry_run: false,
      anuladas: okCount,
      fallidas: results.length - okCount,
      omitidas: skipped.length,
      results, skipped,
      note: 'Las notas de crédito quedan en estado "sent" hasta que Hacienda las resuelva. '
        + 'Revisá la bitácora FE en unos minutos y volvé a emitir esas ventas desde el emisor correcto.',
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /fe-bulk-reemit — vuelve a emitir EN LOTE, ya con la configuración correcta
// del negocio (cédula, certificado, cuenta de Alanube, actividad económica).
// Toma consecutivo NUEVO: en Hacienda un número ya transmitido queda quemado.
//
// Solo son elegibles las que NO están vivas en Hacienda:
//   · rechazadas / con error  → nunca existieron legalmente
//   · anuladas con nota de crédito → ya se dieron de baja
// Una factura ACEPTADA y SIN nota de crédito se OMITE: re-emitirla duplicaría la
// venta ante Hacienda (quedarían dos comprobantes válidos por la misma operación).
//
// body: { tenant_id, invoice_ids?: string[], confirm: "EMITIR", dry_run? }
admin.post('/fe-bulk-reemit', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const body = await c.req.json().catch(() => ({} as any));
    const tenantId = String(body?.tenant_id ?? '').trim();
    if (!tenantId) return fail(c, 'Falta tenant_id', 422);
    const dryRun = body?.dry_run === true;

    const { data: cfgRow } = await db.from('settings').select('config')
      .eq('tenant_id', tenantId).eq('type', 'electronic-invoice').maybeSingle();
    const cfg: any = (cfgRow as any)?.config ?? {};
    const myCed = String(cfg.emisor_identification ?? '').replace(/\D/g, '').replace(/^0+/, '');
    if (!myCed) return fail(c, 'El negocio no tiene cédula del emisor configurada.', 422);
    if (!cfg.enabled) return fail(c, 'La facturación electrónica no está activada para este negocio.', 409);

    let q = db.from('invoices')
      .select('id, invoice_number, fe_clave, fe_status, fe_nc_clave, fe_nc_status, total, issued_at, customer_name, document_type, notes, status')
      .eq('tenant_id', tenantId).limit(2000);
    if (Array.isArray(body?.invoice_ids) && body.invoice_ids.length) q = q.in('id', body.invoice_ids);
    else q = q.not('fe_status', 'is', null);
    const { data: invs, error } = await q;
    if (error) throw new Error(error.message);

    const eligible: any[] = [];
    const skipped: any[] = [];
    for (const inv of (invs ?? []) as any[]) {
      const base = {
        invoice_id: inv.id, invoice_number: inv.invoice_number,
        total: inv.total, customer_name: inv.customer_name, fe_status: inv.fe_status,
      };
      if (inv.status === 'cancelled') { skipped.push({ ...base, motivo: 'La venta está anulada en el sistema.' }); continue; }
      const rechazada = inv.fe_status === 'rejected' || inv.fe_status === 'error';
      const anulada = !!inv.fe_nc_clave;
      if (!rechazada && !anulada) {
        skipped.push({ ...base, motivo: inv.fe_status === 'accepted'
          ? 'ACEPTADA y sin nota de crédito: primero anulala (fe-bulk-credit-notes). Re-emitirla ahora duplicaría la venta ante Hacienda.'
          : 'En proceso: esperá el estado final de Hacienda.' });
        continue;
      }
      eligible.push({ ...base, clave_anterior: inv.fe_clave ?? null, nc_clave: inv.fe_nc_clave ?? null, notes: inv.notes ?? null });
    }

    if (dryRun || String(body?.confirm ?? '') !== 'EMITIR') {
      return ok(c, {
        dry_run: true,
        cedula_configurada: myCed,
        elegibles: eligible.length, omitidas: skipped.length,
        total_a_emitir: eligible.reduce((s, e) => s + Number(e.total ?? 0), 0),
        eligible, skipped,
        note: 'Nada se emitió. Para ejecutar, repetí el llamado con confirm: "EMITIR". '
          + 'Cada factura toma un consecutivo NUEVO y sale con la configuración actual del negocio.',
      });
    }

    const results: any[] = [];
    for (const e of eligible) {
      try {
        // Antes de limpiar el estado FE, dejamos RASTRO de lo anterior en las notas:
        // sin esto se perdería a qué clave/NC correspondía esta venta.
        const trail = `[Re-emitida ${new Date().toISOString().slice(0, 10)}]`
          + (e.clave_anterior ? ` Clave anterior: ${e.clave_anterior}.` : '')
          + (e.nc_clave ? ` Anulada con NC: ${e.nc_clave}.` : ' (rechazada, sin efecto fiscal).');
        const notes = [e.notes, trail].filter(Boolean).join(' ').slice(0, 1000);
        // La nota de crédito anterior pertenece a la clave vieja: el comprobante
        // nuevo nace sin NC.
        await db.from('invoices').update({ notes, fe_nc_clave: null, fe_nc_status: null })
          .eq('id', e.invoice_id).eq('tenant_id', tenantId);

        const res: any = await emitInvoiceCore(c, tenantId, e.invoice_id, { renumber: true });
        const parsed = await res.clone().json().catch(() => null);
        const okRes = !!parsed?.data && !parsed?.error;
        results.push({
          ...e, ok: okRes,
          nueva_clave: parsed?.data?.clave ?? parsed?.data?.fe_clave ?? null,
          nuevo_numero: parsed?.data?.invoice_number ?? null,
          error: parsed?.error ?? null,
        });
      } catch (err: any) {
        results.push({ ...e, ok: false, error: err?.message ?? 'Error desconocido' });
      }
    }

    const okCount = results.filter(r => r.ok).length;
    return ok(c, {
      dry_run: false,
      emitidas: okCount,
      fallidas: results.length - okCount,
      omitidas: skipped.length,
      results, skipped,
      note: 'Quedan en estado "sent" hasta que Hacienda las resuelva; revisá la bitácora FE en unos minutos. '
        + 'La clave anterior y la nota de crédito quedaron registradas en las notas de cada factura.',
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

admin.get('/alanube/duplicate-companies', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const { data: rows } = await db.from('settings')
      .select('tenant_id, config').eq('type', 'electronic-invoice');
    const { data: tenants } = await db.from('tenants').select('id, name');
    const nameById = new Map<string, string>();
    for (const t of (tenants ?? []) as any[]) nameById.set(t.id, t.name);

    // Un registro por (ambiente, company_id).
    const byCompany = new Map<string, any[]>();
    for (const r of (rows ?? []) as any[]) {
      const cfg = r.config ?? {};
      for (const [env, cid] of [
        ['production', cfg.alanube_company_id_production],
        ['sandbox', cfg.alanube_company_id_sandbox],
        ['legacy', cfg.alanube_company_id],
      ] as const) {
        if (!cid) continue;
        const key = `${env}:${cid}`;
        const entry = {
          tenant_id: r.tenant_id,
          business: nameById.get(r.tenant_id) ?? '—',
          env,
          company_id: String(cid),
          cedula: String(cfg.emisor_identification ?? '').replace(/\D/g, '') || null,
          emisor: cfg.emisor_name ?? null,
        };
        byCompany.set(key, [...(byCompany.get(key) ?? []), entry]);
      }
    }

    const duplicates = [...byCompany.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([key, list]) => ({
        company_id: key.split(':').slice(1).join(':'),
        env: key.split(':')[0],
        count: list.length,
        // Cédulas DISTINTAS bajo el mismo id = el caso grave.
        distinct_cedulas: [...new Set(list.map(x => x.cedula).filter(Boolean))],
        tenants: list,
      }));

    return ok(c, {
      duplicates,
      total_conflicts: duplicates.length,
      note: duplicates.length
        ? 'Cada company_id repetido con cédulas distintas es un conflicto: uno de los negocios está emitiendo con la empresa del otro. Cada uno necesita su propia cuenta/token de Alanube.'
        : 'Sin company_id repetidos.',
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /accountants?tenant_id= — contadores del sistema y si llevan ESE negocio.
// Sirve para el modal «Contadores» del panel: una sola llamada trae la lista y el
// estado de cada uno, sin tener que cruzar nada del lado del cliente.
admin.get('/accountants', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const tenantId = c.req.query('tenant_id') || null;
    // Se listan los usuarios con rol contador; si no hay ninguno todavía, se
    // devuelven todos los del negocio para poder elegir a quién ascender.
    let { data: users } = await db.from('users')
      .select('id, email, full_name, role, tenant_id').eq('role', 'contador').limit(500);
    if (!users || users.length === 0) {
      const r = await db.from('users').select('id, email, full_name, role, tenant_id').limit(500);
      users = r.data ?? [];
    }
    const ids = (users ?? []).map((u: any) => u.id);

    // Cuántos negocios lleva cada uno + si lleva el que se está viendo.
    const byUser: Record<string, string[]> = {};
    if (ids.length > 0) {
      const { data: links } = await db.from('user_tenants')
        .select('user_id, tenant_id').in('user_id', ids);
      for (const l of (links ?? []) as any[]) {
        byUser[l.user_id] = [...(byUser[l.user_id] ?? []), l.tenant_id];
      }
    }

    const out = (users ?? []).map((u: any) => ({
      id: u.id,
      email: u.email,
      full_name: u.full_name,
      role: u.role,
      clients: (byUser[u.id] ?? []).length,
      assigned: tenantId ? (byUser[u.id] ?? []).includes(tenantId) : false,
    })).sort((a: any, b: any) =>
      Number(b.assigned) - Number(a.assigned)
      || (b.role === 'contador' ? 1 : 0) - (a.role === 'contador' ? 1 : 0)
      || String(a.full_name ?? a.email).localeCompare(String(b.full_name ?? b.email)));
    return ok(c, out);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /tenants/:id/accountants — da o quita acceso de un contador a ESTE negocio.
// Escribe en `user_tenants`, igual que el acceso a una sucursal.
// body: { accountant_id, assigned: boolean, make_role?: boolean }
admin.post('/tenants/:id/accountants', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const tenantId = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));
    const userId = String(body?.accountant_id ?? '').trim();
    if (!userId) return fail(c, 'Falta accountant_id', 422);

    if (body?.assigned) {
      const { error } = await db.from('user_tenants').upsert({
        user_id: userId, tenant_id: tenantId, role: 'staff', is_default: false,
      }, { onConflict: 'user_id,tenant_id' });
      if (error) throw new Error(error.message);
      // Si se pidió, se le pone el rol contador para que vea el portal.
      if (body?.make_role) {
        try { await db.from('users').update({ role: 'contador' }).eq('id', userId); }
        catch (e: any) { console.warn('[accountants] rol:', e?.message); }
      }
    } else {
      // No se quita el acceso a su PROPIO negocio: lo dejaría fuera de su cuenta.
      const { data: u } = await db.from('users').select('tenant_id').eq('id', userId).maybeSingle();
      if ((u as any)?.tenant_id === tenantId) {
        return fail(c, 'Ese es el negocio principal del usuario: no se le puede quitar el acceso.', 409);
      }
      const { error } = await db.from('user_tenants').delete()
        .eq('user_id', userId).eq('tenant_id', tenantId);
      if (error) throw new Error(error.message);
    }
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

admin.post('/sync-customers', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const body = await c.req.json().catch(() => ({} as any));
    const r = await syncTenantsToCustomers(c.get('tenantId'), body?.tenant_id ? String(body.tenant_id) : null);
    return ok(c, r);
  } catch (err: any) { return fail(c, err.message, 500); }
});

admin.post('/tenants/:id/fe-renew', async (c) => {
  try {
    const { id } = c.req.param();

    // Lo que SOBRA de la bolsa vigente se arrastra a la nueva. Son comprobantes
    // ya pagados: hacerlos caducar al renovar sería cobrar dos veces por lo
    // mismo. Se mide ANTES de reiniciar, que es cuando el dato todavía existe.
    let carryover = 0;
    try {
      const q: any = await computeFeQuota(id);
      // Solo si la bolsa es limitada y quedó saldo. En sobregiro no se arrastra
      // una deuda: el excedente ya se factura aparte, y meterlo en la bolsa nueva
      // castigaría dos veces por el mismo consumo.
      if (Number(q?.included) > 0 && Number(q?.available) > 0) {
        carryover = Math.floor(Number(q.available));
      }
    } catch (e: any) {
      console.warn('[fe-renew] no se pudo calcular el arrastre:', e?.message);
    }

    const { data: row } = await db.from('settings')
      .select('config').eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const cfg = {
      ...((row as any)?.config ?? {}),
      fe_quota_start: new Date().toISOString(),
      // Reemplaza, no suma: el arrastre anterior ya estaba contado dentro del
      // `available` que se acaba de medir. Sumarlo lo duplicaría en cada renovación.
      fe_quota_carryover: carryover,
    };
    await db.from('settings').upsert({
      tenant_id: id, type: 'electronic-invoice', config: cfg,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' });
    return ok(c, { ok: true, fe_quota_start: cfg.fe_quota_start, carryover });
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
      // Traemos las filas con alguna clave de Hacienda y contamos cada comprobante
      // (factura/tiquete + NC + ND), separando por PROVEEDOR. El proveedor se
      // deduce del consecutivo: Alanube usa un ULID (con letras), Facturemos uno
      // numérico. Así se puede aislar la parte de Alanube y compararla con su reporte.
      // Se EXCLUYEN los comprobantes RECHAZADOS/ERROR (no consumen bolsa).
      const failed = (s: any) => s === 'rejected' || s === 'error';
      let sel: any = await db.from('invoices')
        .select('fe_consecutivo, fe_clave, fe_status, fe_nc_clave, fe_nc_status, fe_nd_clave, fe_nd_status')
        .eq('tenant_id', r.tenant_id).gte('created_at', start)
        .or('fe_clave.not.is.null,fe_nc_clave.not.is.null,fe_nd_clave.not.is.null');
      if (sel.error) {   // columnas NC/ND (o status) sin migrar → intento mínimo
        sel = await db.from('invoices').select('fe_consecutivo, fe_clave, fe_status')
          .eq('tenant_id', r.tenant_id).gte('created_at', start).not('fe_clave', 'is', null);
      }
      let docs = 0, ncs = 0, nds = 0, usedAlanube = 0, usedFacturemos = 0;
      for (const row of (sel.data ?? []) as any[]) {
        const isAlanube = /[A-Za-z]/.test(String(row.fe_consecutivo ?? ''));
        const okDoc = row.fe_clave && !failed(row.fe_status);
        const okNc = row.fe_nc_clave && !failed(row.fe_nc_status);
        const okNd = row.fe_nd_clave && !failed(row.fe_nd_status);
        const inRow = (okDoc ? 1 : 0) + (okNc ? 1 : 0) + (okNd ? 1 : 0);
        if (okDoc) docs++;
        if (okNc) ncs++;
        if (okNd) nds++;
        if (isAlanube) usedAlanube += inRow; else usedFacturemos += inRow;
      }
      const used = docs + ncs + nds;
      const extraFee = Number(cfg.fe_extra_fee ?? 0);          // ₡ por comprobante extra (del plan)
      const overage = Math.max(0, used - included);            // comprobantes sobre la bolsa
      result[r.tenant_id] = {
        included, used, available: included - used,
        used_alanube: usedAlanube, used_facturemos: usedFacturemos,
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

// GET /tenants/:id/fe-consecutivos — en qué número va cada serie AHORA.
//
// Es la verdad del sistema, no lo configurado: sirve para comprobar que el
// «próximo» que se puso en Datos de FE es el que realmente se va a usar.
admin.get('/tenants/:id/fe-consecutivos', async (c) => {
  try {
    const { id } = c.req.param();
    const { data, error } = await db.from('fe_consecutivos')
      .select('sucursal, terminal, tipo, last_number, updated_at')
      .eq('tenant_id', id).order('tipo');
    // Si la migración 83 no corrió todavía, la tabla no existe: no es un error
    // del usuario, simplemente no hay contadores que mostrar.
    if (error) return ok(c, { rows: [], available: false, message: error.message });
    return ok(c, { rows: data ?? [], available: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /tenants/:id/fe-consecutivos — fija el ÚLTIMO consecutivo emitido de una
// serie. El siguiente comprobante sale con ese número + 1.
// body: { tipo: '01'|'02'|'03'|'04', last_number: number, sucursal?, terminal? }
admin.put('/tenants/:id/fe-consecutivos', async (c) => {
  try {
    const { id } = c.req.param();
    const b = await c.req.json().catch(() => ({} as any));
    const tipo = String(b?.tipo ?? '');
    if (!['01', '02', '03', '04'].includes(tipo)) return fail(c, 'Tipo inválido (01/02/03/04)', 422);
    const last = Number(b?.last_number);
    if (!Number.isFinite(last) || last < 0) return fail(c, 'Número inválido', 422);

    const sucursal = String(b?.sucursal ?? '001').replace(/\D/g, '').padStart(3, '0').slice(-3);
    const terminal = String(b?.terminal ?? '00001').replace(/\D/g, '').padStart(5, '0').slice(-5);

    const { error } = await db.from('fe_consecutivos').upsert({
      tenant_id: id, sucursal, terminal, tipo,
      last_number: Math.floor(last), updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,sucursal,terminal,tipo' });
    if (error) throw new Error(error.message);

    return ok(c, { ok: true, tipo, last_number: Math.floor(last), next: Math.floor(last) + 1 });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── Permisos por rol de UNA empresa (desde el Panel Admin) ─────────────────
//
// Los mismos datos que el negocio edita en Usuarios → Roles, pero alcanzables
// sin tener que entrar a la empresa. Cuando el super-admin crea los usuarios de
// un cliente, lo natural es dejarle los permisos listos ahí mismo; obligarlo a
// cambiar de empresa para eso era la vuelta larga.

// GET /tenants/:id/role-permissions/:role
admin.get('/tenants/:id/role-permissions/:role', async (c) => {
  try {
    const { id, role } = c.req.param();
    const { data, error } = await db.from('role_permissions')
      .select('module, can_access, can_create, can_edit, can_delete')
      .eq('tenant_id', id).eq('role', role);
    if (error) throw new Error(error.message);

    const out: Record<string, any> = {};
    for (const r of (data ?? []) as any[]) {
      out[r.module] = {
        can_access: r.can_access, can_create: r.can_create,
        can_edit: r.can_edit, can_delete: r.can_delete,
      };
    }
    return ok(c, out);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /tenants/:id/role-permissions/:role
admin.put('/tenants/:id/role-permissions/:role', async (c) => {
  try {
    const { id, role } = c.req.param();
    if (role === 'owner') return fail(c, 'El dueño siempre tiene acceso total.', 422);

    const body = await c.req.json().catch(() => ({} as any));
    const matrix = (body?.permissions ?? body) as Record<string, any>;
    if (!matrix || typeof matrix !== 'object') return fail(c, 'Matriz inválida', 422);

    // Se reemplaza la matriz completa: así un módulo que se quita desaparece de
    // verdad. Dejar filas viejas sueltas era lo que hacía que revocar no revocara.
    const { error: delErr } = await db.from('role_permissions')
      .delete().eq('tenant_id', id).eq('role', role);
    if (delErr) throw new Error(delErr.message);

    const rows = Object.entries(matrix).map(([module, p]: [string, any]) => ({
      tenant_id: id, role, module,
      can_access: p?.can_access === true,
      can_create: p?.can_create === true,
      can_edit:   p?.can_edit   === true,
      can_delete: p?.can_delete === true,
    }));
    if (rows.length) {
      const { error } = await db.from('role_permissions').insert(rows);
      if (error) throw new Error(error.message);
    }
    clearPermissionCache();   // el middleware cachea un minuto
    return ok(c, { ok: true, modules: rows.length });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /fe-log — BITÁCORA de facturas electrónicas de TODAS las empresas.
// Para monitoreo del super-admin: ver emisiones y detectar errores rápido.
// Filtros: ?tenant_id= (una empresa) · ?search= (cliente/consecutivo/clave/factura)
//          · ?from= ?to= (fecha) · ?status= (error/accepted/sent/rejected)
// GET /alanube/reports/emissions — reportes de Alanube (conteo de comprobantes
// por empresa y por usuario en un rango de fechas). Usa el token del ambiente
// (cuenta), así que devuelve TODAS las empresas de la cuenta = todos los tenants.
admin.get('/alanube/reports/emissions', async (c) => {
  try {
    const env = c.req.query('env') === 'sandbox' ? 'sandbox' : 'production';
    const from = c.req.query('from');
    const until = c.req.query('until');
    if (!from || !until) return fail(c, 'Indicá el rango de fechas (desde/hasta).', 422);
    const legalStatus = c.req.query('legalStatus') || undefined;   // ACCEPTED/REJECTED
    const status = c.req.query('status') || undefined;
    const client = alanube.forEnv(env);
    // Los reportes son POR CUENTA (token). Desde que un negocio puede tener su
    // propia cuenta de Alanube, consultar solo el token global dejaba fuera a esos
    // emisores y el reporte salía "sin emisiones".
    const extraTokens: Array<{ token: string; tenants: string[] }> = [];
    try {
      const { data: feRows } = await db.from('settings')
        .select('tenant_id, config').eq('type', 'electronic-invoice');
      const byToken = new Map<string, string[]>();
      for (const row of (feRows ?? []) as any[]) {
        const tok = tenantAlanubeToken(row.config ?? {}, env as any);
        if (!tok) continue;
        byToken.set(tok, [...(byToken.get(tok) ?? []), row.tenant_id]);
      }
      for (const [token, tenants] of byToken) extraTokens.push({ token, tenants });
    } catch (e: any) { console.warn('[alanube reports] tokens propios:', e?.message); }

    const [perCompany, byUser] = await Promise.allSettled([
      client.reportEmissionsPerCompany(from, until, { legalStatus, status }),
      client.reportEmissionsByUser(from, until, legalStatus || 'ACCEPTED'),
    ]);
    const unwrap = (r: PromiseSettledResult<any>) => {
      if (r.status === 'fulfilled') return r.value?.data ?? r.value ?? [];
      // Estos casos NO son errores que mostrar, solo "sin datos":
      //  · 404 / "no data" / RPT002 = no hubo emisiones en el rango.
      //  · 403 / Forbidden = el plan/token de Alanube no habilita ese reporte.
      const msg = r.reason instanceof Error ? r.reason.message : 'error';
      const st = r.reason instanceof AlanubeError ? r.reason.status : 0;
      if (st === 404 || st === 403 || /no data|not found|sin datos|no se encontr|forbidden|rpt\d+/i.test(msg)) return [];
      return { error: msg };
    };
    const perC = unwrap(perCompany);
    const byU = unwrap(byUser);

    // El reporte de Alanube SOLO trae empresas con emisiones en el rango. Para que
    // aparezcan TODAS las empresas registradas (aunque no hayan emitido), fusionamos
    // con las empresas Alanube guardadas por los tenants (en 0 las que no emitieron).
    if (Array.isArray(perC)) {
      try {
        const { data: feRows } = await db.from('settings').select('config').eq('type', 'electronic-invoice');
        const present = new Set(perC.map((r: any) => String(r.idCompany ?? r.id ?? '')));
        const zeros: any[] = [];
        for (const row of (feRows ?? []) as any[]) {
          const cfg = row.config ?? {};
          const id = String((env === 'sandbox' ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id ?? '');
          if (!id || present.has(id)) continue;
          present.add(id);
          zeros.push({
            idCompany: id,
            companyName: cfg.emisor_commercial_name || cfg.emisor_name || '(sin nombre)',
            companyEmail: cfg.emisor_email ?? '',
            invoices: 0, exportInvoices: 0, purchaseInvoices: 0, creditNotes: 0,
            debitNotes: 0, receiverMessages: 0, tickets: 0, paymentReceipts: 0, total: 0,
            _noEmissions: true,   // marca para el frontend (opcional)
          });
        }
        // Empresas con emisiones primero (ordenadas por total), luego las inactivas.
        perC.sort((a: any, b: any) => Number(b.total || 0) - Number(a.total || 0));
        perC.push(...zeros);
      } catch { /* si falla la fusión, devolvemos solo las que trajo Alanube */ }
    }
    // Agregar lo que reporten las cuentas PROPIAS de cada negocio.
    // EN PARALELO a propósito: en serie, con varias cuentas propias, la suma de
    // esperas pasaba el límite de 30 s de la función y la pantalla moría con un
    // error de plataforma en vez de mostrar lo que sí se pudo traer.
    const extraDiag: any[] = [];
    const extraResults = await Promise.allSettled(
      extraTokens.map(({ token }) => alanube.forEnv(env, token)
        .reportEmissionsPerCompany(from, until, { legalStatus, status })),
    );
    extraResults.forEach((res, i) => {
      const tenants = extraTokens[i]?.tenants;
      if (res.status === 'rejected') {
        extraDiag.push({ tenants, ok: false, error: (res.reason as any)?.message ?? 'error' });
        return;
      }
      const r: any = res.value;
      const rows = r?.data ?? r ?? [];
      if (Array.isArray(rows) && Array.isArray(perC)) {
        const present = new Set(perC.map((x: any) => String(x.idCompany ?? x.id ?? '')));
        for (const row of rows) {
          const id = String(row.idCompany ?? row.id ?? '');
          if (id && present.has(id)) continue;
          perC.push({ ...row, _ownAccount: true });
        }
      }
      extraDiag.push({ tenants, ok: true, rows: Array.isArray(rows) ? rows.length : 0 });
    });

    // Modo diagnóstico: devuelve la respuesta CRUDA de Alanube (tal cual, sin
    // desenvolver) para ver los nombres reales de los campos y corregir el mapeo.
    const debug = c.req.query('debug') === '1';
    const rawOf = (r: PromiseSettledResult<any>) =>
      r.status === 'fulfilled' ? r.value : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
    return ok(c, {
      env, from, until,
      per_company: perC, by_user: byU,
      // Bandera para que el frontend sepa que el token trae datos aunque un reporte
      // esté vacío/forbidden.
      has_data: (Array.isArray(perC) && perC.length > 0) || (Array.isArray(byU) && byU.length > 0),
      // Motivo REAL cuando no hay filas: sin esto un 403 (el plan de Alanube no
      // habilita el reporte) o un token inválido se veían igual que "no hubo ventas".
      diagnostico: (() => {
        const why = (r: PromiseSettledResult<any>) => {
          if (r.status === 'fulfilled') return null;
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          const st = r.reason instanceof AlanubeError ? r.reason.status : 0;
          if (st === 403 || /forbidden/i.test(msg)) return `Alanube respondió 403: la cuenta/plan no habilita este reporte (${msg})`;
          if (st === 404 || /no data|not found|rpt\d+/i.test(msg)) return 'Alanube respondió "sin datos" para el rango consultado';
          if (/invalid credentials|unauthorized|token/i.test(msg)) return `Token de Alanube inválido para ${env}: ${msg}`;
          return msg;
        };
        return {
          per_company: why(perCompany),
          by_user: why(byUser),
          cuentas_propias: extraDiag,
          token_global: !!(env === 'production' ? process.env.ALANUBE_API_TOKEN_PRODUCTION : process.env.ALANUBE_API_TOKEN_SANDBOX),
        };
      })(),
      ...(debug ? { raw: { per_company: rawOf(perCompany), by_user: rawOf(byUser) } } : {}),
    });
  } catch (err: any) {
    const st = err instanceof AlanubeError ? err.status : 500;
    return fail(c, err.message, st);
  }
});

// POST /fe-refresh/:id — REINTENTO: re-consulta el estado de una factura en Hacienda
// (para el botón de reintento en la bitácora). Resuelve el tenant de la factura.
admin.post('/fe-refresh/:id', async (c) => {
  try {
    const raw = c.req.param('id');
    // Las notas de crédito/débito se muestran en la bitácora como filas SINTÉTICAS
    // con id "<uuid-de-la-factura>-nc" (o "-nd"): no existen como fila propia en
    // `invoices`. Sin esto el reintento respondía "Factura no encontrada".
    const noteKind = /-nc$/.test(raw) ? 'nc' : /-nd$/.test(raw) ? 'nd' : null;
    const id = noteKind ? raw.replace(/-(nc|nd)$/, '') : raw;

    const { data: inv } = await db.from('invoices')
      .select('tenant_id, fe_nc_clave, fe_nc_status, fe_nd_clave, fe_nd_status').eq('id', id).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);

    // Al refrescar una NOTA se consulta el estado de la NOTA (por su propia clave),
    // no el de la factura: son documentos distintos ante Hacienda.
    if (noteKind) {
      const r = await refreshNoteStatus((inv as any).tenant_id, id, noteKind);
      return ok(c, r);
    }

    const r = await refreshInvoiceStatus((inv as any).tenant_id, id);
    return ok(c, r);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /fe-reemit/:id — RE-EMITE (solo admin) la misma factura corrigiendo el
// consecutivo: reasigna el número respetando el consecutivo configurado en Datos de
// FE y limpia el estado FE previo, luego la vuelve a enviar a Hacienda/Alanube.
// POST /fe-credit-note/:id — emite la NOTA DE CRÉDITO de anulación de una factura
// desde la bitácora (solo admin). Resuelve el tenant por la factura.
// body: { reason?, emisor_tenant_id? }  — emisor_tenant_id: el negocio que HOY tiene
// configurada la cédula con la que salió la factura (cuando no es el mismo).
admin.post('/fe-credit-note/:id', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const id = c.req.param('id').replace(/-(nc|nd)$/, '');
    const body = await c.req.json().catch(() => ({} as any));
    const { data: inv } = await db.from('invoices')
      .select('tenant_id, fe_clave, fe_status, fe_nc_clave').eq('id', id).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    if ((inv as any).fe_nc_clave) return fail(c, 'Esta factura ya tiene una nota de crédito.', 409);
    if (!(inv as any).fe_clave) return fail(c, 'La factura no fue emitida electrónicamente.', 422);

    const emisorTenantId = String(body?.emisor_tenant_id ?? '').trim() || (inv as any).tenant_id;

    // Hacienda solo acepta la anulación desde el MISMO emisor del documento: se
    // valida la cédula de la clave contra la configurada antes de emitir.
    const { data: cfgRow } = await db.from('settings').select('config')
      .eq('tenant_id', emisorTenantId).eq('type', 'electronic-invoice').maybeSingle();
    const cfgNc: any = (cfgRow as any)?.config ?? {};
    const companyIdOverride = String(body?.company_id ?? '').trim() || null;

    // Con qué cédula va a salir REALMENTE la nota. Manda la de la EMPRESA de
    // Alanube que se va a usar (es la que aporta el certificado y la identidad),
    // no el campo de Datos de FE: al recrear una empresa esos dos quedan
    // desincronizados y el guard bloqueaba de más.
    let emisorCed = String(cfgNc.emisor_identification ?? '').replace(/\D/g, '').replace(/^0+/, '');
    let cedFuente = 'la configuración de Datos de FE';
    const companyToCheck = companyIdOverride
      ?? (String(cfgNc.environment ?? 'production') === 'sandbox'
        ? cfgNc.alanube_company_id_sandbox : cfgNc.alanube_company_id_production)
      ?? cfgNc.alanube_company_id;
    if (companyToCheck && cfgNc.fe_provider === 'alanube') {
      try {
        const co: any = await alanube.forTenant(cfgNc).getCompany(String(companyToCheck));
        const ced = companyCedula(co?.company ?? co).replace(/^0+/, '');
        if (ced) { emisorCed = ced; cedFuente = `la empresa ${companyToCheck} en Alanube`; }
      } catch (e: any) { console.warn('[fe-credit-note] no se pudo leer la empresa:', e?.message); }
    }

    const clave = String((inv as any).fe_clave ?? '').replace(/\D/g, '');
    if (clave.length === 50 && emisorCed) {
      const claveCed = clave.slice(9, 21).replace(/^0+/, '');
      if (claveCed !== emisorCed) {
        return fail(c,
          `Esta factura salió con la cédula ${claveCed}, pero la nota saldría con ${emisorCed} `
          + `(según ${cedFuente}).\n\n`
          + 'Hacienda solo acepta la nota de crédito desde el emisor que emitió el documento.\n\n'
          + `Necesitás una empresa en Alanube registrada con la cédula ${claveCed} y su certificado, `
          + 'y usar su ID acá. Si la recreaste con otro contribuyente, esa empresa ya no sirve para anular '
          + 'este comprobante.', 422);
      }
    }

    // Si vino un `company_id`, SE GUARDA en la config del ambiente para no tener
    // que repetirlo en las próximas notas.
    if (companyIdOverride) {
      try {
        const cfg: any = { ...((cfgRow as any)?.config ?? {}) };
        const key = String(cfg.environment ?? 'production') === 'sandbox'
          ? 'alanube_company_id_sandbox' : 'alanube_company_id_production';
        if (cfg[key] !== companyIdOverride) {
          cfg[key] = companyIdOverride;
          cfg.alanube_company_id = companyIdOverride;
          await db.from('settings').upsert({
            tenant_id: emisorTenantId, type: 'electronic-invoice', config: cfg,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'tenant_id,type' });
        }
      } catch (e: any) { console.warn('[fe-credit-note] guardar company_id:', e?.message); }
    }

    return await emitCreditNoteCore(c, emisorTenantId, id, body?.reason, { companyIdOverride });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// body opcional: { consecutivo?: number } — consecutivo de Hacienda EXACTO.
//
// Sin él se toma «el siguiente» de la serie, que es justo lo que no sirve cuando
// el contador quedó atrasado: Hacienda contesta «numeration was already used» y
// re-emitir vuelve a fallar con el mismo número, una y otra vez. Pasando el
// número se sale del bucle, y el contador queda adelantado para que las ventas
// normales sigan desde ahí.
admin.post('/fe-reemit/:id', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const { id } = c.req.param();
    const b = await c.req.json().catch(() => ({} as any));
    const consecutivo = Number(b?.consecutivo);
    if (b?.consecutivo !== undefined && b?.consecutivo !== null && b?.consecutivo !== ''
        && (!Number.isFinite(consecutivo) || consecutivo < 1 || consecutivo > 9_999_999_999)) {
      return fail(c, 'El consecutivo debe ser un número entre 1 y 9999999999.', 422);
    }
    const { data: inv } = await db.from('invoices').select('tenant_id').eq('id', id).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    return await emitInvoiceCore(c, (inv as any).tenant_id, id, {
      renumber: true,
      ...(Number.isFinite(consecutivo) && consecutivo >= 1 ? { consecutivo } : {}),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /fe-next-consecutivo/:id — qué consecutivo le tocaría a ESTA factura.
//
// Es lo que se le muestra al admin antes de re-emitir: el número que el sistema
// usaría por su cuenta, para que pueda ver de un vistazo si el contador está
// atrasado respecto de lo que Hacienda ya recibió, y corregirlo ahí mismo.
admin.get('/fe-next-consecutivo/:id', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const { id } = c.req.param();
    const { data: inv } = await db.from('invoices')
      .select('tenant_id, document_type').eq('id', id).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    const tenantId = (inv as any).tenant_id;
    const docType = String((inv as any).document_type ?? '');
    const tipo = docType === 'factura_electronica' ? '01' : '04';

    const { data: cfgRow } = await db.from('settings').select('config')
      .eq('tenant_id', tenantId).eq('type', 'electronic-invoice').maybeSingle();
    const cfg: any = (cfgRow as any)?.config ?? {};
    const sucursal = String(cfg.sucursal ?? '1').replace(/\D/g, '').padStart(3, '0').slice(-3);
    const terminal = String(cfg.terminal ?? '1').replace(/\D/g, '').padStart(5, '0').slice(-5);

    let last = 0;
    try {
      const { data } = await db.from('fe_consecutivos').select('last_number')
        .eq('tenant_id', tenantId).eq('sucursal', sucursal).eq('terminal', terminal).eq('tipo', tipo)
        .maybeSingle();
      last = Number((data as any)?.last_number ?? 0);
    } catch { /* migración 83 sin correr: se cae al configurado */ }

    const floor = configuredNextConsecutivo(cfg, docType);
    return ok(c, {
      tipo, sucursal, terminal,
      last_number: last,
      suggested: Math.max(last + 1, floor, 1),
      configured_next: floor || null,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /fe-log/export — bitácora para EXCEL: una fila por comprobante, con el
// desglose de IVA POR TARIFA (0 %, 1 %, 2 %, 4 %, 13 %). El IVA no se guarda en la
// factura sino que sale de la tarifa de cada producto, así que se reconstruye
// leyendo los ítems. Va aparte de /fe-log para no frenar la bitácora en pantalla.
// Filtros: tenant_id, from, to, status, search (los mismos que /fe-log).
admin.get('/fe-log/export', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const tenantId = c.req.query('tenant_id');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const status = c.req.query('status');
    const search = (c.req.query('search') || '').trim();
    const limit = Math.min(Number(c.req.query('limit') || 5000), 20000);

    let q = db.from('invoices')
      .select('id, tenant_id, invoice_number, customer_name, customer_id, subtotal, tax_amount, total, '
        + 'issued_at, created_at, document_type, payment_method, status, fe_clave, fe_consecutivo, fe_status, fe_error')
      .order('issued_at', { ascending: false }).limit(limit);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    if (status)   q = q.eq('fe_status', status);
    if (from)     q = q.gte('issued_at', from);
    if (to)       q = q.lte('issued_at', endOfDay(to));
    if (search) {
      const t = search.replace(/[%,]/g, ' ');
      q = q.or(`customer_name.ilike.%${t}%,fe_consecutivo.ilike.%${t}%,fe_clave.ilike.%${t}%,invoice_number.ilike.%${t}%`);
    }
    const { data: invs, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (invs ?? []) as any[];
    if (rows.length === 0) return ok(c, { rows: [], rates: [] });

    // Ítems de esas facturas (en tandas: PostgREST corta el `in` muy largo).
    const ids = rows.map(r => r.id);
    const items: any[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await db.from('invoice_items')
        .select('invoice_id, product_id, quantity, unit_price, subtotal')
        .in('invoice_id', ids.slice(i, i + 200));
      items.push(...(data ?? []));
    }

    // Tarifa de IVA por producto.
    const pids = [...new Set(items.map(it => it.product_id).filter(Boolean))];
    const rateByProduct = new Map<string, number>();
    for (let i = 0; i < pids.length; i += 200) {
      const { data } = await db.from('products').select('id, iva_rate').in('id', pids.slice(i, i + 200) as string[]);
      for (const p of (data ?? []) as any[]) rateByProduct.set(p.id, Number(p.iva_rate ?? 13));
    }

    // Base e IVA por tarifa, factura por factura.
    const byInvoice = new Map<string, { base: Record<string, number>; iva: Record<string, number> }>();
    const ratesSeen = new Set<number>();
    for (const it of items) {
      const rate = it.product_id ? (rateByProduct.get(it.product_id) ?? 13) : 13;
      ratesSeen.add(rate);
      const acc = byInvoice.get(it.invoice_id) ?? { base: {}, iva: {} };
      const base = Number(it.subtotal ?? 0);
      acc.base[rate] = (acc.base[rate] ?? 0) + base;
      acc.iva[rate]  = (acc.iva[rate] ?? 0) + Math.round(base * (rate / 100) * 100) / 100;
      byInvoice.set(it.invoice_id, acc);
    }

    const nameById = new Map<string, string>();
    const tids = [...new Set(rows.map(r => r.tenant_id))];
    if (tids.length) {
      const { data: ts } = await db.from('tenants').select('id, name').in('id', tids);
      for (const t of (ts ?? []) as any[]) nameById.set(t.id, t.name);
    }

    // Tarifas presentes + las estándar de Costa Rica, para columnas estables.
    const rates = [...new Set([0, 1, 2, 4, 13, ...ratesSeen])].sort((a, b) => a - b);

    const out = rows.map(r => {
      const acc = byInvoice.get(r.id) ?? { base: {}, iva: {} };
      const clave = String(r.fe_clave ?? '').replace(/\D/g, '');
      const row: Record<string, any> = {
        negocio: nameById.get(r.tenant_id) ?? '—',
        numero: r.invoice_number ?? '',
        tipo: r.document_type ?? '',
        fecha: r.issued_at ?? r.created_at ?? '',
        cliente: r.customer_name ?? '',
        estado_fe: r.fe_status ?? '',
        clave: clave || '',
        emisor_cedula: clave.length === 50 ? clave.slice(9, 21).replace(/^0+/, '') : '',
        consecutivo_fe: r.fe_consecutivo ?? '',
        metodo_pago: r.payment_method ?? '',
        anulada: r.status === 'cancelled' ? 'Sí' : 'No',
        error: r.fe_error ?? '',
      };
      for (const rate of rates) {
        row[`base_${rate}`] = Math.round((acc.base[rate] ?? 0) * 100) / 100;
        row[`iva_${rate}`]  = Math.round((acc.iva[rate] ?? 0) * 100) / 100;
      }
      row.subtotal = Number(r.subtotal ?? 0);
      row.iva_total = Number(r.tax_amount ?? 0);
      row.total = Number(r.total ?? 0);
      return row;
    });

    return ok(c, { rows: out, rates });
  } catch (err: any) { return fail(c, err.message, 500); }
});

admin.get('/fe-log', async (c) => {
  try {
    const tenantId = c.req.query('tenant_id');
    const search = (c.req.query('search') || '').trim();
    const from = c.req.query('from');
    const to = c.req.query('to');
    const status = c.req.query('status');
    const limit = Math.min(Number(c.req.query('limit') || 500), 2000);

    let q = db.from('invoices')
      .select('id, tenant_id, invoice_number, customer_name, total, issued_at, created_at, document_type, fe_clave, fe_consecutivo, fe_status, fe_error, fe_emailed, fe_request, fe_response, fe_nc_clave, fe_nc_status, fe_nd_clave, fe_nd_status')
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
    if (error && /fe_request|fe_response|fe_emailed/.test(error.message)) {
      let q2 = db.from('invoices')
        .select('id, tenant_id, invoice_number, customer_name, total, issued_at, created_at, document_type, fe_clave, fe_consecutivo, fe_status, fe_error, fe_nc_clave, fe_nc_status, fe_nd_clave, fe_nd_status')
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
    // Cédula del emisor CONFIGURADA hoy en cada negocio (para comparar contra la
    // que quedó grabada en la clave de cada comprobante).
    const cedByTenant = new Map<string, string>();
    if (tenantIds.length) {
      const { data: cfgs } = await db.from('settings')
        .select('tenant_id, config').eq('type', 'electronic-invoice').in('tenant_id', tenantIds);
      for (const cr of (cfgs ?? []) as any[]) {
        const ced = String(cr.config?.emisor_identification ?? '').replace(/\D/g, '').replace(/^0+/, '');
        if (ced) cedByTenant.set(cr.tenant_id, ced);
      }
    }
    /** Cédula del emisor grabada en la clave de Hacienda (posiciones 9..20). */
    const emisorDeClave = (clave: any): string | null => {
      const d = String(clave ?? '').replace(/\D/g, '');
      if (d.length !== 50) return null;
      return d.slice(9, 21).replace(/^0+/, '') || null;
    };

    // Expandir: cada factura + (si tiene) su NOTA DE CRÉDITO y su NOTA DE DÉBITO
    // como filas propias en la bitácora (las notas se guardan en la misma factura).
    const out: any[] = [];
    for (const r of rows) {
      const business_name = nameById.get(r.tenant_id) ?? '—';
      const cedConfig = cedByTenant.get(r.tenant_id) ?? null;
      const cedClave = emisorDeClave(r.fe_clave);
      out.push({
        ...r, business_name,
        // Con qué cédula salió REALMENTE el comprobante, y si difiere de la que el
        // negocio tiene configurada hoy (empresa de Alanube compartida/recreada).
        emisor_cedula: cedClave,
        emisor_config: cedConfig,
        emisor_mismatch: !!(cedClave && cedConfig && cedClave !== cedConfig),
      });
      if (r.fe_nc_clave) {
        out.push({
          emisor_cedula: emisorDeClave(r.fe_nc_clave),
          emisor_config: cedConfig,
          emisor_mismatch: !!(emisorDeClave(r.fe_nc_clave) && cedConfig && emisorDeClave(r.fe_nc_clave) !== cedConfig),
          id: `${r.id}-nc`, tenant_id: r.tenant_id, business_name,
          invoice_number: r.invoice_number, parent_invoice_number: r.invoice_number,
          customer_name: r.customer_name, total: r.total,
          issued_at: r.issued_at, created_at: r.created_at,
          document_type: 'nota_credito', is_note: true,
          fe_clave: r.fe_nc_clave, fe_consecutivo: null,
          fe_status: r.fe_nc_status ?? 'sent', fe_error: null,
        });
      }
      if (r.fe_nd_clave) {
        out.push({
          emisor_cedula: emisorDeClave(r.fe_nd_clave),
          emisor_config: cedConfig,
          emisor_mismatch: !!(emisorDeClave(r.fe_nd_clave) && cedConfig && emisorDeClave(r.fe_nd_clave) !== cedConfig),
          id: `${r.id}-nd`, tenant_id: r.tenant_id, business_name,
          invoice_number: r.invoice_number, parent_invoice_number: r.invoice_number,
          customer_name: r.customer_name, total: r.total,
          issued_at: r.issued_at, created_at: r.created_at,
          document_type: 'nota_debito', is_note: true,
          fe_clave: r.fe_nd_clave, fe_consecutivo: null,
          fe_status: r.fe_nd_status ?? 'sent', fe_error: null,
        });
      }
    }
    // Si hay filtro de estado, aplicarlo también a las notas (por su propio estado).
    const finalRows = status
      ? out.filter(r => String(r.fe_status ?? '').toLowerCase() === status.toLowerCase())
      : out;
    finalRows.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

    // Contadores rápidos.
    const errors = finalRows.filter(r => String(r.fe_status).toLowerCase() === 'error').length;
    return ok(c, { count: finalRows.length, errors, rows: finalRows });
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

    // Filtros comunes (empresa, fechas, búsqueda) reutilizados por la lista y por
    // los conteos de KPI.
    const applyFilters = (q: any) => {
      if (tenantId) q = q.eq('tenant_id', tenantId);
      if (from)     q = q.gte('created_at', from);
      if (to)       q = q.lte('created_at', endOfDay(to));
      if (search) {
        const s = search.replace(/[%,]/g, ' ');
        q = q.or(`issuer_name.ilike.%${s}%,issuer_id.ilike.%${s}%,clave.ilike.%${s}%`);
      }
      return q;
    };

    let q = applyFilters(db.from('received_documents')
      .select('id, tenant_id, clave, issuer_name, issuer_id, document_type, doc_date, total, tax, ack_status, source, kind, purchase_id, created_at')
      .order('created_at', { ascending: false })
      .limit(limit));
    // La bitácora muestra SOLO comprobantes con respuesta FINAL de Hacienda
    // (aceptados / rechazados / error); los pendientes se ocultan salvo que se
    // filtre explícitamente por ese estado.
    if (status) q = q.eq('ack_status', status);
    else        q = q.neq('ack_status', 'pending');

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

    // Productos creados/cargados por cada compra (para ver qué generó cada factura)
    // + el N° de orden de compra.
    const purchaseIds = [...new Set(rows.map(r => r.purchase_id).filter(Boolean))] as string[];
    const productsByPurchase = new Map<string, Array<{ name: string; quantity: number; unit_price: number }>>();
    const poNumber = new Map<string, string>();
    if (purchaseIds.length) {
      const [{ data: pit }, { data: pos }] = await Promise.all([
        db.from('purchase_items').select('purchase_id, product_id, quantity, unit_price').in('purchase_id', purchaseIds),
        db.from('purchases').select('id, purchase_number').in('id', purchaseIds),
      ]);
      for (const p of (pos ?? []) as any[]) poNumber.set(p.id, p.purchase_number);
      const items = (pit ?? []) as any[];
      const pids = [...new Set(items.map(i => i.product_id).filter(Boolean))] as string[];
      const prodName = new Map<string, string>();
      if (pids.length) {
        const { data: prods } = await db.from('products').select('id, name').in('id', pids);
        for (const p of (prods ?? []) as any[]) prodName.set(p.id, p.name);
      }
      for (const it of items) {
        const arr = productsByPurchase.get(it.purchase_id) ?? [];
        arr.push({ name: prodName.get(it.product_id) ?? 'Producto', quantity: Number(it.quantity ?? 0), unit_price: Number(it.unit_price ?? 0) });
        productsByPurchase.set(it.purchase_id, arr);
      }
    }

    // KPIs por estado (independientes del filtro de la lista) — conteos exactos.
    const countBy = async (states: string[]) => {
      const { count } = await applyFilters(
        db.from('received_documents').select('id', { count: 'exact', head: true }),
      ).in('ack_status', states);
      return count ?? 0;
    };
    const [accepted, rejected, pending] = await Promise.all([
      countBy(['accepted', '1']),
      countBy(['rejected', 'error', '3']),
      countBy(['pending']),
    ]);
    return ok(c, {
      count: accepted + rejected + pending, accepted, rejected, pending,
      rows: rows.map(r => ({
        ...r,
        business_name: nameById.get(r.tenant_id) ?? '—',
        purchase_number: r.purchase_id ? (poNumber.get(r.purchase_id) ?? null) : null,
        products: r.purchase_id ? (productsByPurchase.get(r.purchase_id) ?? []) : [],
      })),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ─── WhatsApp: recordatorios de pago (super-admin) ──────────────────────────

// Días restantes de la suscripción activa (más reciente) de un tenant.
async function subscriptionDaysLeft(tenantId: string): Promise<number | null> {
  const { data: sub } = await db.from('subscriptions')
    .select('ends_at').eq('tenant_id', tenantId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const endsAt = (sub as any)?.ends_at;
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

// POST /clean-product-names — limpieza masiva: quita la basura que algunos
// proveedores meten en el <Detalle> (";número;…") de los nombres de productos
// YA guardados. Paginado. Devuelve cuántos limpió.
admin.post('/clean-product-names', async (c) => {
  try {
    const PAGE = 1000;
    let cleaned = 0, scanned = 0;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db.from('products').select('id, name')
        .like('name', '%;%').order('id', { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const chunk = (data ?? []) as any[];
      for (const p of chunk) {
        scanned++;
        const m = String(p.name ?? '').match(/^(.*?);\s*\d/);   // nombre real antes de ";<número>"
        if (!m) continue;
        const clean = m[1].trim();
        if (clean && clean !== p.name) {
          await db.from('products').update({ name: clean, updated_at: new Date().toISOString() }).eq('id', p.id);
          cleaned++;
        }
      }
      if (chunk.length < PAGE) break;
    }
    return ok(c, { cleaned, scanned });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /whatsapp/status — ¿está configurado el envío por WhatsApp?
admin.get('/whatsapp/status', (c) => ok(c, { enabled: whatsappEnabled() }));

// POST /whatsapp/test — envía la plantilla de prueba `hello_world` (Meta la trae
// pre-aprobada) para verificar token/número. body: { to } (número destino).
// En sandbox el destino debe estar registrado como "número de prueba" en Meta.
admin.post('/whatsapp/test', async (c) => {
  try {
    if (!whatsappEnabled()) return fail(c, 'WhatsApp no configurado (falta WHATSAPP_TOKEN en .env)', 400);
    const { to } = await c.req.json().catch(() => ({}));
    const phone = normalizePhone(to);
    if (!phone) return fail(c, 'Número destino inválido', 422);
    const r = await sendTemplate(phone, 'hello_world', [], 'en_US');
    if (!r.ok) return fail(c, r.error || 'No se pudo enviar', 502);
    return ok(c, { sent: true, phone, id: r.id });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /whatsapp/payment-reminder — recordatorio de pago a UN negocio.
// body: { tenantId, days? }  (si no se pasa days, se calcula de la suscripción)
admin.post('/whatsapp/payment-reminder', async (c) => {
  try {
    if (!whatsappEnabled()) return fail(c, 'WhatsApp no configurado (falta WHATSAPP_TOKEN)', 400);
    const { tenantId, days } = await c.req.json();
    if (!tenantId) return fail(c, 'tenantId requerido', 422);
    const d = Number.isFinite(Number(days)) ? Number(days) : (await subscriptionDaysLeft(tenantId) ?? 0);
    const { phone } = await businessContact(tenantId);
    if (!phone) return fail(c, 'El negocio no tiene teléfono de WhatsApp (emisor_phone)', 422);
    const r = await notifyPaymentDue(tenantId, d);
    if (!r.ok) return fail(c, r.error || 'No se pudo enviar', 502);
    return ok(c, { sent: true, phone, days: d, id: r.id });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /whatsapp/payment-reminders-bulk — a todos los negocios que vencen pronto.
// body: { withinDays?=7 }
admin.post('/whatsapp/payment-reminders-bulk', async (c) => {
  try {
    if (!whatsappEnabled()) return fail(c, 'WhatsApp no configurado (falta WHATSAPP_TOKEN)', 400);
    const body = await c.req.json().catch(() => ({}));
    const within = Number.isFinite(Number(body?.withinDays)) ? Number(body.withinDays) : 7;
    const limit = new Date(Date.now() + within * 86_400_000).toISOString();

    // Suscripciones activas que vencen dentro de la ventana.
    const { data: subs } = await db.from('subscriptions')
      .select('tenant_id, ends_at')
      .eq('status', 'active')
      .lte('ends_at', limit)
      .gte('ends_at', new Date().toISOString());
    const list = Array.isArray(subs) ? subs : [];

    let sent = 0, skipped = 0, failed = 0;
    const details: any[] = [];
    for (const s of list) {
      const tid = (s as any).tenant_id;
      const ms = new Date((s as any).ends_at).getTime() - Date.now();
      const d = Math.max(0, Math.ceil(ms / 86_400_000));
      const r = await notifyPaymentDue(tid, d);
      if (r.ok) sent++; else if (r.skipped) skipped++; else failed++;
      details.push({ tenantId: tid, days: d, ok: r.ok, skipped: r.skipped, error: r.error });
    }
    return ok(c, { total: list.length, sent, skipped, failed, details });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ════════════════════════════════════════════════════════════════════════════
// WhatsApp por QR (Baileys) — proxy al worker persistente.
// El worker NO vive en Vercel (serverless); corre en un host siempre encendido.
// Estas rutas reenvían al worker usando el secreto compartido (nunca llega al
// browser). Solo admin/owner (el panel admin gestiona el número ColónClick).
// Env: WHATSAPP_WORKER_URL, WHATSAPP_WORKER_SECRET
// ════════════════════════════════════════════════════════════════════════════
function waWorkerBase(): string {
  return (process.env.WHATSAPP_WORKER_URL || '').trim().replace(/\/+$/, '');
}
function isAdminRole(c: any): boolean {
  const role = c.get('role');
  return role === 'owner' || role === 'admin';
}
async function callWorker(path: string, init?: RequestInit): Promise<Response> {
  const base = waWorkerBase();
  if (!base) throw new Error('WHATSAPP_WORKER_URL no configurado');
  return fetch(base + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-worker-secret': (process.env.WHATSAPP_WORKER_SECRET || '').trim(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

// GET /admin/whatsapp-qr/status — estado de la sesión (para pintar el QR / conectado).
// Ojo: NO usar '/whatsapp/status' — ya existe otra ruta con ese path (Cloud API)
// que gana por registrarse antes y devuelve otra forma.
admin.get('/whatsapp-qr/status', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  if (!waWorkerBase()) return ok(c, { configured: false, state: 'unconfigured', connected: false, qr: null, me: null });
  try {
    const r = await callWorker('/status');
    const data: any = await r.json().catch(() => ({}));
    // El worker respondió pero rechazó el secreto → diagnóstico claro.
    if (r.status === 401) {
      return ok(c, { configured: true, state: 'unreachable', connected: false, qr: null, me: null,
        error: 'El worker respondió 401: WHATSAPP_WORKER_SECRET (backend) ≠ WORKER_SECRET (worker).' });
    }
    if (!r.ok || !data?.state) {
      return ok(c, { configured: true, state: 'unreachable', connected: false, qr: null, me: null,
        error: `El worker respondió HTTP ${r.status}. Revisá WHATSAPP_WORKER_URL.` });
    }
    return ok(c, { configured: true, ...data });
  } catch (err: any) {
    return ok(c, { configured: true, state: 'unreachable', connected: false, qr: null, me: null,
      error: `No se pudo conectar al worker (${err.message}). Revisá WHATSAPP_WORKER_URL y que el worker esté encendido.` });
  }
});

// POST /admin/whatsapp-qr/send — { to, text } envía un mensaje de prueba.
admin.post('/whatsapp-qr/send', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const body = await c.req.json().catch(() => ({}));
    const r = await callWorker('/send', { method: 'POST', body: JSON.stringify(body) });
    const data: any = await r.json();
    return c.json(data, r.status as any);
  } catch (err: any) { return fail(c, err.message, 502); }
});

// POST /admin/whatsapp-qr/logout — cierra la sesión y fuerza un QR nuevo.
admin.post('/whatsapp-qr/logout', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const r = await callWorker('/logout', { method: 'POST' });
    const data: any = await r.json();
    return c.json(data, r.status as any);
  } catch (err: any) { return fail(c, err.message, 502); }
});

// GET /admin/whatsapp-qr/notify-phone?tenant=... — número dedicado a avisos
// (recordatorios de pago / errores de Hacienda) de UN negocio.
admin.get('/whatsapp-qr/notify-phone', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  const tenant = c.req.query('tenant');
  if (!tenant) return fail(c, 'tenant requerido', 400);
  const { data } = await db.from('settings').select('config')
    .eq('tenant_id', tenant).eq('type', 'general').maybeSingle();
  const cfg: any = (data as any)?.config ?? {};
  return ok(c, { notify_phone: cfg.notify_phone ?? '', emisor_phone: cfg.emisor_phone ?? '' });
});

// POST /admin/whatsapp-qr/notify-phone { tenant, phone } — guarda el número.
admin.post('/whatsapp-qr/notify-phone', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const b = await c.req.json().catch(() => ({}));
    const tenant = b?.tenant;
    if (!tenant) return fail(c, 'tenant requerido', 400);
    const { data } = await db.from('settings').select('config')
      .eq('tenant_id', tenant).eq('type', 'general').maybeSingle();
    const cfg: any = (data as any)?.config ?? {};
    cfg.notify_phone = String(b?.phone ?? '').trim();
    const { error } = await db.from('settings').upsert(
      { tenant_id: tenant, type: 'general', config: cfg, updated_at: new Date().toISOString() },
      { onConflict: 'tenant_id,type' },
    );
    if (error) throw new Error(error.message);
    return ok(c, { ok: true, notify_phone: cfg.notify_phone });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ════════════════════════════════════════════════════════════════════════════
// Pagos de proveedores de la PLATAFORMA (ColónClick). Registro interno del Panel
// Admin — global (no por tenant). Solo owner/admin. Tabla `vendor_payments`.
// ════════════════════════════════════════════════════════════════════════════

// GET /admin/vendor-payments — lista completa ordenada por vencimiento.
admin.get('/vendor-payments', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const { data, error } = await db.from('vendor_payments')
      .select('*')
      .order('paid', { ascending: true })
      .order('due_date', { ascending: true, nullsFirst: false });
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /admin/vendor-payments — crear.
admin.post('/vendor-payments', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const b = await c.req.json().catch(() => ({}));
    if (!String(b?.vendor ?? '').trim()) return fail(c, 'El proveedor es obligatorio', 400);
    const row = {
      vendor: String(b.vendor).trim(),
      concept: b.concept ? String(b.concept).trim() : null,
      amount: Number(b.amount ?? 0),
      currency: b.currency === 'USD' ? 'USD' : 'CRC',
      due_date: b.due_date || null,
      paid: !!b.paid,
      paid_date: b.paid ? (b.paid_date || new Date().toISOString().slice(0, 10)) : null,
      recurring: b.recurring === 'monthly' || b.recurring === 'yearly' ? b.recurring : null,
      notes: b.notes ? String(b.notes).trim() : null,
    };
    const { data, error } = await db.from('vendor_payments').insert(row).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /admin/vendor-payments/:id — editar.
admin.put('/vendor-payments/:id', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const patch: any = { updated_at: new Date().toISOString() };
    if (b.vendor !== undefined) patch.vendor = String(b.vendor).trim();
    if (b.concept !== undefined) patch.concept = b.concept ? String(b.concept).trim() : null;
    if (b.amount !== undefined) patch.amount = Number(b.amount ?? 0);
    if (b.currency !== undefined) patch.currency = b.currency === 'USD' ? 'USD' : 'CRC';
    if (b.due_date !== undefined) patch.due_date = b.due_date || null;
    if (b.recurring !== undefined) patch.recurring = (b.recurring === 'monthly' || b.recurring === 'yearly') ? b.recurring : null;
    if (b.notes !== undefined) patch.notes = b.notes ? String(b.notes).trim() : null;
    if (b.paid !== undefined) {
      patch.paid = !!b.paid;
      patch.paid_date = b.paid ? (b.paid_date || new Date().toISOString().slice(0, 10)) : null;
    }
    const { data, error } = await db.from('vendor_payments').update(patch).eq('id', id).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /admin/vendor-payments/:id/pay — marcar como pagado (fecha opcional).
admin.post('/vendor-payments/:id/pay', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const paid_date = b?.paid_date || new Date().toISOString().slice(0, 10);
    const { data, error } = await db.from('vendor_payments')
      .update({ paid: true, paid_date, updated_at: new Date().toISOString() })
      .eq('id', id).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /admin/vendor-payments/:id/unpay — revertir a pendiente.
admin.post('/vendor-payments/:id/unpay', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const id = c.req.param('id');
    const { data, error } = await db.from('vendor_payments')
      .update({ paid: false, paid_date: null, updated_at: new Date().toISOString() })
      .eq('id', id).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// DELETE /admin/vendor-payments/:id
admin.delete('/vendor-payments/:id', async (c) => {
  if (!isAdminRole(c)) return fail(c, 'forbidden', 403);
  try {
    const id = c.req.param('id');
    const { error } = await db.from('vendor_payments').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default admin;
