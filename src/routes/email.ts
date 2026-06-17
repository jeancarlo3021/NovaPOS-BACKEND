import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import {
  sendEmail, emailEnabled,
  invoiceEmailHtml, welcomeEmailHtml,
  paymentReceiptEmailHtml, paymentReminderEmailHtml, newBusinessEmailHtml,
  planFeatureLabels,
} from '../services/emailService.js';

const email = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// Nombre del negocio para las plantillas (settings.general.businessName o tenants.name).
async function businessName(tenantId: string): Promise<string> {
  try {
    const { data: s } = await db.from('settings').select('config').eq('tenant_id', tenantId).eq('type', 'general').maybeSingle();
    const bn = (s?.config as any)?.businessName;
    if (bn) return bn;
  } catch { /* ignore */ }
  const { data: t } = await db.from('tenants').select('name').eq('id', tenantId).maybeSingle();
  return t?.name || 'ColónClick';
}

// Resuelve el correo y nombre del dueño de un tenant.
async function ownerInfo(tenantId: string): Promise<{ email?: string; name?: string }> {
  const { data: t } = await db.from('tenants').select('owner_id, name').eq('id', tenantId).maybeSingle();
  const ownerId = (t as any)?.owner_id;
  if (!ownerId) return {};
  const { data: u } = await db.from('users').select('email, full_name').eq('id', ownerId).maybeSingle();
  if (u?.email) return { email: u.email, name: (u as any).full_name };
  // Fallback a Supabase Auth si no está en public.users.
  try {
    const { data: au } = await db.auth.admin.getUserById(ownerId);
    return { email: au?.user?.email ?? undefined, name: (au?.user?.user_metadata as any)?.full_name };
  } catch { return {}; }
}

// Trae la suscripción activa + plan de un tenant.
async function subInfo(tenantId: string) {
  const { data: sub } = await db.from('subscriptions')
    .select('ends_at, started_at, plan:plan_id(name, price, billing_cycle, max_users, max_products, max_orders, features)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return sub as any;
}

// GET /status — saber si el correo está configurado (para la UI)
email.get('/status', (c) => ok(c, { enabled: emailEnabled() }));

// POST /test — { to } enviar un correo de prueba
email.post('/test', async (c) => {
  try {
    const { to } = await c.req.json();
    if (!to) return fail(c, 'Falta el destinatario (to)', 422);
    const r = await sendEmail({
      to,
      subject: 'Correo de prueba · ColónClick',
      html: '<p>¡Funciona! Este es un correo de prueba enviado con Resend.</p>',
    });
    return ok(c, { id: r.id });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /invoice/:id — { to } enviar el comprobante de una factura al cliente
email.post('/invoice/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { to } = await c.req.json().catch(() => ({}));

    const { data: inv, error } = await db.from('invoices')
      .select('*, invoice_items(*)')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!inv) return fail(c, 'Factura no encontrada', 404);

    const recipient = to || (inv as any).customer_email;
    if (!recipient) return fail(c, 'No hay correo de destino para esta factura', 422);

    // Nombres de producto
    const rawItems = (inv as any).invoice_items ?? [];
    const productIds = [...new Set(rawItems.map((it: any) => it.product_id).filter(Boolean))] as string[];
    let nameById = new Map<string, string>();
    if (productIds.length > 0) {
      const { data: prods } = await db.from('products').select('id, name').in('id', productIds);
      nameById = new Map((prods ?? []).map((p: any) => [p.id, p.name]));
    }
    const items = rawItems.map((it: any) => ({
      name: it.product_name || nameById.get(it.product_id) || 'Producto',
      quantity: Number(it.quantity ?? 0),
      unit_price: Number(it.unit_price ?? 0),
      subtotal: Number(it.subtotal ?? 0),
    }));

    const bn = await businessName(tenantId);
    const html = invoiceEmailHtml({
      businessName: bn,
      invoiceNumber: (inv as any).invoice_number ?? id,
      date: new Date((inv as any).issued_at ?? (inv as any).created_at ?? Date.now()).toLocaleString('es-CR', { dateStyle: 'short', timeStyle: 'short' }),
      customerName: (inv as any).customer_name ?? undefined,
      items,
      subtotal: Number((inv as any).subtotal ?? 0),
      tax: Number((inv as any).tax_amount ?? 0),
      total: Number((inv as any).total ?? 0),
    });

    const r = await sendEmail({ to: recipient, subject: `Comprobante ${(inv as any).invoice_number ?? ''} · ${bn}`, html });
    return ok(c, { id: r.id, to: recipient });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /welcome — { to, full_name, username } correo de bienvenida
email.post('/welcome', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { to, full_name, username } = await c.req.json();
    if (!to) return fail(c, 'Falta el destinatario (to)', 422);
    const bn = await businessName(tenantId);
    const html = welcomeEmailHtml({ fullName: full_name ?? '', businessName: bn, username: username ?? to });
    const r = await sendEmail({ to, subject: `Bienvenido a ${bn}`, html });
    return ok(c, { id: r.id });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /payment-receipt — comprobante de pago del SaaS.
// body: { tenant_id, type, amount, payment_date?, period_start?, period_end?,
//         payment_method?, reference?, next_billing?, notes?, to? }
email.post('/payment-receipt', async (c) => {
  try {
    const b = await c.req.json();
    const tenantId = b.tenant_id || c.get('tenantId');
    if (!tenantId) return fail(c, 'Falta tenant_id', 422);
    const bn = await businessName(tenantId);
    const to = b.to || (await ownerInfo(tenantId)).email;
    if (!to) return fail(c, 'No se encontró el correo del dueño del negocio', 422);

    const html = paymentReceiptEmailHtml({
      businessName: bn,
      type: b.type === 'invoicing' ? 'invoicing' : 'subscription',
      amount: Number(b.amount ?? 0),
      paymentDate: b.payment_date,
      periodStart: b.period_start,
      periodEnd: b.period_end,
      paymentMethod: b.payment_method,
      reference: b.reference,
      nextBilling: b.next_billing,
      notes: b.notes,
    });
    const r = await sendEmail({ to, subject: `Comprobante de pago · ${bn}`, html });
    return ok(c, { id: r.id, to });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /payment-reminder — recordatorio de pago. body: { tenant_id, to? }
email.post('/payment-reminder', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({}));
    const tenantId = b.tenant_id || c.get('tenantId');
    if (!tenantId) return fail(c, 'Falta tenant_id', 422);
    const bn = await businessName(tenantId);
    const owner = await ownerInfo(tenantId);
    const to = b.to || owner.email;
    if (!to) return fail(c, 'No se encontró el correo del dueño del negocio', 422);

    const sub = await subInfo(tenantId);
    const endsAt = sub?.ends_at ?? null;
    const daysLeft = endsAt ? Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86400000) : undefined;
    const html = paymentReminderEmailHtml({
      businessName: bn,
      planName: sub?.plan?.name,
      amount: sub?.plan?.price != null ? Number(sub.plan.price) : undefined,
      endsAt,
      daysLeft,
    });
    const r = await sendEmail({ to, subject: `Recordatorio de pago · ${bn}`, html });
    return ok(c, { id: r.id, to });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /new-business — comprobante de alta / uso del sistema. body: { tenant_id, to? }
email.post('/new-business', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({}));
    const tenantId = b.tenant_id || c.get('tenantId');
    if (!tenantId) return fail(c, 'Falta tenant_id', 422);
    const bn = await businessName(tenantId);
    const owner = await ownerInfo(tenantId);
    const to = b.to || owner.email;
    if (!to) return fail(c, 'No se encontró el correo del dueño del negocio', 422);

    const sub = await subInfo(tenantId);
    const plan = sub?.plan ?? null;
    const features = planFeatureLabels(plan?.features);
    const nextBilling = sub?.ends_at ?? null;
    const html = newBusinessEmailHtml({
      businessName: bn,
      ownerName: owner.name,
      ownerEmail: owner.email,
      planName: plan?.name,
      billingCycle: plan?.billing_cycle,
      price: plan?.price != null ? Number(plan.price) : undefined,
      startDate: sub?.started_at ?? null,
      nextBilling,
      maxUsers: plan?.max_users ?? null,
      maxProducts: plan?.max_products ?? null,
      maxOrders: plan?.max_orders ?? null,
      features,
    });
    const r = await sendEmail({ to, subject: `Bienvenido · ${bn}`, html });
    return ok(c, { id: r.id, to });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default email;
