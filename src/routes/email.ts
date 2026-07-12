import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import {
  sendEmail, emailEnabled,
  invoiceEmailHtml, welcomeEmailHtml,
  paymentReceiptEmailHtml, paymentReminderEmailHtml, newBusinessEmailHtml,
  planFeatureLabels,
} from '../services/emailService.js';
import { reportPdfBase64 } from '../services/reportPdf.js';

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

// POST /report — envía un reporte (cierre de caja, distribución) por correo a
// los correos configurados (settings general.close_report_emails) + los que
// vengan en `to`. body: { subject, title, subtitle?, sections:[{heading, rows:[[a,b]]}], to? }
const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
function parseEmails(v: any): string[] {
  if (Array.isArray(v)) return v.map(String);
  return String(v ?? '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
}
// HTML con apariencia de TICKET de cierre (monoespaciado, bordes por sección),
// para que el correo se vea igual que el cierre impreso del POS / distribución.
function reportHtml(title: string, subtitle: string, sections: Array<{ heading?: string; rows: Array<[string, string]> }>): string {
  const secs = sections.map(s => `
    ${s.heading ? `<div style="font-weight:900;font-size:13px;border-top:3px solid #000;border-bottom:3px solid #000;margin:8px 0 4px;padding:3px 0;letter-spacing:1px;text-align:center">${s.heading}</div>` : ''}
    <table style="width:100%;border-collapse:collapse">
      ${s.rows.map(([a, b]) => `<tr><td style="padding:2px 0;font-weight:800">${a}</td><td style="padding:2px 0;text-align:right;font-weight:900">${b}</td></tr>`).join('')}
    </table>`).join('');
  return `<div style="font-family:'Courier New',Courier,monospace;max-width:340px;margin:0 auto;padding:14px;color:#000;background:#fff;font-weight:700;line-height:1.6">
    <div style="font-size:18px;font-weight:900;text-align:center;letter-spacing:2px;padding:4px 0;margin-bottom:6px;border-top:4px solid #000;border-bottom:4px solid #000">${title.toUpperCase()}</div>
    ${subtitle ? `<div style="font-size:12px;font-weight:800;text-align:center;margin-bottom:6px">${subtitle}</div>` : ''}
    ${secs}
    <div style="text-align:center;font-size:11px;color:#666;margin-top:16px;border-top:2px dashed #999;padding-top:8px">Generado automáticamente por ColónClick</div>
  </div>`;
}

email.post('/report', async (c) => {
  try {
    if (!emailEnabled()) return ok(c, { sent: 0, note: 'Email no configurado en el servidor' });
    const tenantId = c.get('tenantId');
    const b = await c.req.json();
    const { data: gen } = await db.from('settings').select('config')
      .eq('tenant_id', tenantId).eq('type', 'general').maybeSingle();
    const cfgEmails = parseEmails((gen?.config as any)?.close_report_emails);
    const recipients = Array.from(new Set([...(Array.isArray(b.to) ? b.to : []), ...cfgEmails]))
      .map(String).filter(isEmail);
    if (recipients.length === 0) return ok(c, { sent: 0, note: 'Sin correos configurados' });

    const title = String(b.title ?? 'Reporte');
    const subtitle = String(b.subtitle ?? '');
    const sections = Array.isArray(b.sections) ? b.sections : [];
    const html = reportHtml(title, subtitle, sections);

    // PDF adjunto con el mismo diseño (ticket de cierre).
    let attachments: Array<{ filename: string; content: string }> | undefined;
    try {
      const pdf = await reportPdfBase64(title, subtitle, sections);
      const safe = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'reporte';
      attachments = [{ filename: `${safe}.pdf`, content: pdf }];
    } catch { /* si el PDF falla, se manda solo el HTML */ }

    let sent = 0;
    for (const r of recipients) {
      try { await sendEmail({ to: r, subject: String(b.subject ?? title), html, attachments }); sent++; }
      catch { /* seguir con los demás */ }
    }
    return ok(c, { sent });
  } catch (err: any) { return fail(c, err.message, 500); }
});

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
