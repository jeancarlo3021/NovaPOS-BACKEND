import { Resend } from 'resend';

// Cliente Resend. La API key vive solo en el backend (RESEND_API_KEY).
// Sin key configurada, el servicio queda "deshabilitado" y las llamadas
// devuelven un error claro en vez de romper.
const apiKey = process.env.RESEND_API_KEY ?? '';
const FROM = process.env.EMAIL_FROM || 'ColonClick <onboarding@resend.dev>';

const resend = apiKey ? new Resend(apiKey) : null;

export const emailEnabled = () => !!resend;

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
  attachments?: Array<{ filename: string; content: string /* base64 */ }>;
}

export async function sendEmail(input: SendEmailInput): Promise<{ id: string }> {
  if (!resend) {
    throw new Error('Email no configurado: falta RESEND_API_KEY en el servidor.');
  }
  const { data, error } = await resend.emails.send({
    from: FROM,
    to: input.to,
    subject: input.subject,
    html: input.html,
    replyTo: input.replyTo,
    attachments: input.attachments,
  });
  if (error) throw new Error(error.message || 'Error al enviar el correo');
  return { id: data?.id ?? '' };
}

// ─── Plantilla base ───────────────────────────────────────────────────────────
const fmtCRC = (n: number) => `₡${Number(n || 0).toLocaleString('es-CR')}`;

function layout(title: string, body: string, brand = 'ColónClick'): string {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#2563eb;border-radius:16px 16px 0 0;padding:20px 24px;">
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:800;">${brand}</h1>
    </div>
    <div style="background:#fff;border-radius:0 0 16px 16px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.1);">
      <h2 style="margin:0 0 12px;font-size:18px;">${title}</h2>
      ${body}
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:16px;">
      Este correo fue enviado por ${brand}. Si no lo esperabas, podés ignorarlo.
    </p>
  </div>
</body></html>`;
}

// ─── 1) Comprobante / factura al cliente ────────────────────────────────────────
export function invoiceEmailHtml(opts: {
  businessName: string;
  invoiceNumber: string;
  date: string;
  customerName?: string;
  items: Array<{ name: string; quantity: number; unit_price: number; subtotal: number }>;
  subtotal: number;
  tax: number;
  total: number;
}): string {
  const rows = opts.items.map(it => `
    <tr>
      <td style="padding:6px 0;border-bottom:1px solid #f3f4f6;">${it.name}<br><span style="color:#9ca3af;font-size:12px;">${it.quantity} × ${fmtCRC(it.unit_price)}</span></td>
      <td style="padding:6px 0;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:700;">${fmtCRC(it.subtotal)}</td>
    </tr>`).join('');

  const body = `
    <p style="margin:0 0 4px;">Hola${opts.customerName ? ` ${opts.customerName}` : ''}, gracias por tu compra.</p>
    <p style="margin:0 0 16px;color:#6b7280;font-size:14px;">Comprobante <strong>${opts.invoiceNumber}</strong> · ${opts.date}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px;">
      <tr><td style="padding:2px 0;color:#6b7280;">Subtotal</td><td style="padding:2px 0;text-align:right;">${fmtCRC(opts.subtotal)}</td></tr>
      <tr><td style="padding:2px 0;color:#6b7280;">Impuesto</td><td style="padding:2px 0;text-align:right;">${fmtCRC(opts.tax)}</td></tr>
      <tr><td style="padding:8px 0;font-weight:800;font-size:16px;">Total</td><td style="padding:8px 0;text-align:right;font-weight:800;font-size:16px;color:#2563eb;">${fmtCRC(opts.total)}</td></tr>
    </table>`;
  return layout(`Tu comprobante de ${opts.businessName}`, body, opts.businessName);
}

// ─── 1b) Factura / cobro personalizado (primer cobro del SaaS) ──────────────────
export function customInvoiceEmailHtml(opts: {
  businessName: string;
  ownerName?: string | null;
  planName?: string | null;
  items: Array<{ description: string; amount: number }>;
  total: number;
  dueDate?: string | null;
  notes?: string | null;
  planFeatures?: string[];
  paymentInfo?: string | null;
}): string {
  const rows = opts.items.map(it => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">${it.description}</td>
      <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:700;">${fmtCRC(it.amount)}</td>
    </tr>`).join('');

  const features = (opts.planFeatures && opts.planFeatures.length > 0)
    ? `<div style="margin-top:18px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 16px;">
         <p style="margin:0 0 8px;font-weight:800;color:#166534;">Tu plan${opts.planName ? ` ${opts.planName}` : ''} incluye:</p>
         <ul style="margin:0;padding-left:18px;color:#15803d;font-size:14px;">
           ${opts.planFeatures.map(f => `<li style="padding:2px 0;">${f}</li>`).join('')}
         </ul>
       </div>`
    : '';

  const body = `
    <p style="margin:0 0 4px;">Hola${opts.ownerName ? ` ${opts.ownerName}` : ''}, este es tu cobro de <strong>${opts.businessName}</strong>.</p>
    ${opts.dueDate ? `<p style="margin:0 0 16px;color:#6b7280;font-size:14px;">Fecha límite de pago: <strong>${opts.dueDate}</strong></p>` : '<p style="margin:0 0 16px;"></p>'}
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px;">
      <tr><td style="padding:10px 0;font-weight:800;font-size:16px;">Total a pagar</td>
          <td style="padding:10px 0;text-align:right;font-weight:800;font-size:18px;color:#2563eb;">${fmtCRC(opts.total)}</td></tr>
    </table>
    ${features}
    ${opts.paymentInfo ? `<div style="margin-top:18px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:14px 16px;font-size:14px;color:#1e3a8a;"><strong>Cómo pagar:</strong><br>${opts.paymentInfo.replace(/\n/g, '<br>')}</div>` : ''}
    ${opts.notes ? `<p style="margin-top:16px;color:#6b7280;font-size:13px;white-space:pre-wrap;">${opts.notes}</p>` : ''}`;
  return layout('Tu cobro', body, opts.businessName);
}

// ─── 2) Bienvenida de usuario ───────────────────────────────────────────────────
export function welcomeEmailHtml(opts: { fullName: string; businessName: string; username: string }): string {
  const body = `
    <p>¡Hola ${opts.fullName}!</p>
    <p>Se creó tu cuenta en <strong>${opts.businessName}</strong>.</p>
    <p style="background:#f3f4f6;border-radius:8px;padding:12px;">Usuario: <strong>${opts.username}</strong></p>
    <p style="color:#6b7280;font-size:14px;">Tu contraseña te la comparte el administrador. Te recomendamos cambiarla al ingresar.</p>`;
  return layout('Bienvenido', body, opts.businessName);
}

// Tabla de "etiqueta: valor" reutilizable.
function detailRows(rows: Array<[string, string | undefined | null]>): string {
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0;">` +
    rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `
      <tr>
        <td style="padding:6px 0;color:#6b7280;border-bottom:1px solid #f3f4f6;">${k}</td>
        <td style="padding:6px 0;text-align:right;font-weight:700;border-bottom:1px solid #f3f4f6;">${v}</td>
      </tr>`).join('') +
    `</table>`;
}

const fmtDate = (s?: string | null) => {
  if (!s) return undefined;
  try { return new Date(s.length <= 10 ? s + 'T12:00:00' : s).toLocaleDateString('es-CR', { dateStyle: 'long' }); }
  catch { return s; }
};

// ─── 3) Comprobante de pago (SaaS) ──────────────────────────────────────────────
export function paymentReceiptEmailHtml(opts: {
  businessName: string;
  type: 'subscription' | 'invoicing';
  amount: number;
  paymentDate?: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  paymentMethod?: string | null;
  reference?: string | null;
  nextBilling?: string | null;
  notes?: string | null;
}): string {
  const typeLabel = opts.type === 'subscription' ? 'Suscripción del sistema' : 'Facturación electrónica';
  const body = `
    <p>Recibimos tu pago. Este es tu comprobante.</p>
    <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:14px;text-align:center;margin:12px 0;">
      <p style="margin:0;color:#065f46;font-size:13px;">Monto pagado</p>
      <p style="margin:4px 0 0;color:#059669;font-size:26px;font-weight:800;">${fmtCRC(opts.amount)}</p>
    </div>
    ${detailRows([
      ['Concepto', typeLabel],
      ['Negocio', opts.businessName],
      ['Fecha de pago', fmtDate(opts.paymentDate)],
      ['Período', opts.periodStart || opts.periodEnd ? `${fmtDate(opts.periodStart) ?? ''} – ${fmtDate(opts.periodEnd) ?? ''}` : undefined],
      ['Método de pago', opts.paymentMethod ?? undefined],
      ['Referencia', opts.reference ?? undefined],
      ['Próximo cobro', fmtDate(opts.nextBilling)],
    ])}
    ${opts.notes ? `<p style="color:#6b7280;font-size:13px;">Nota: ${opts.notes}</p>` : ''}
    <p style="color:#6b7280;font-size:14px;">¡Gracias por confiar en nosotros!</p>`;
  return layout('Comprobante de pago', body, opts.businessName);
}

// ─── 4) Recordatorio de pago (SaaS) ─────────────────────────────────────────────
export function paymentReminderEmailHtml(opts: {
  businessName: string;
  planName?: string;
  amount?: number;
  endsAt?: string | null;
  daysLeft?: number;
}): string {
  const venc = fmtDate(opts.endsAt);
  const body = `
    <p>Te recordamos que tu suscripción está por vencer.</p>
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:14px;margin:12px 0;">
      <p style="margin:0;color:#92400e;font-weight:700;">
        ${opts.daysLeft != null ? (opts.daysLeft <= 0 ? 'Vencida' : `Vence en ${opts.daysLeft} día${opts.daysLeft === 1 ? '' : 's'}`) : 'Próxima a vencer'}
      </p>
    </div>
    ${detailRows([
      ['Negocio', opts.businessName],
      ['Plan', opts.planName ?? undefined],
      ['Monto a pagar', opts.amount ? fmtCRC(opts.amount) : undefined],
      ['Fecha de vencimiento', venc],
    ])}
    <p style="color:#6b7280;font-size:14px;">Realizá tu pago a tiempo para no perder acceso al sistema.</p>`;
  return layout('Recordatorio de pago', body, opts.businessName);
}

// Convierte los flags del plan (pos, pos_card, inventory…) en etiquetas legibles
// en español, agrupando sub-características bajo su módulo principal.
export function planFeatureLabels(features: Record<string, unknown> | null | undefined): string[] {
  const f: any = features ?? {};
  const on = (k: string) => f[k] === true;
  const a: string[] = [];
  if (on('pos')) {
    a.push('Punto de venta');
    if (on('pos_card')) a.push('Cobro con tarjeta (datáfono)');
    if (on('pos_sinpe')) a.push('Cobro por SINPE Móvil');
    if (on('pos_discount')) a.push('Descuentos en venta');
    if (on('pos_cash_management')) a.push('Apertura y cierre de caja');
  }
  if (on('inventory')) a.push(on('inventory_products_only') ? 'Inventario básico' : 'Inventario completo');
  if (on('reports')) a.push(on('reports_basic') ? 'Reportes básicos' : 'Reportes avanzados');
  if (on('expenses')) a.push('Control de gastos');
  if (on('purchases')) a.push('Órdenes de compra');
  if (on('accounts_payable')) a.push('Cuentas por pagar');
  if (on('multi_branch')) { a.push('Multi-sucursal'); if (on('multi_branch_transfers')) a.push('Traslados entre sucursales'); }
  if (on('promotions')) a.push('Promociones');
  if (on('tables')) a.push('Mapa de mesas (restaurante)');
  if (on('recipes')) a.push('Recetas');
  if (on('customers')) a.push('Clientes');
  if (on('hr')) a.push('Recursos humanos');
  if (on('users')) a.push('Gestión de usuarios');
  if (on('settings')) a.push('Configuración del negocio');
  if (on('electronic_invoicing')) a.push('Facturación electrónica');
  if (on('kiosk')) a.push('Modo kiosko');
  return a;
}

// ─── 6) Restablecer contraseña (lo cambia el propio cliente) ────────────────────
export function passwordResetEmailHtml(opts: { businessName: string; ownerName?: string; link: string }): string {
  const body = `
    <p>Hola${opts.ownerName ? ` ${opts.ownerName}` : ''},</p>
    <p>Recibimos una solicitud para cambiar la contraseña de tu cuenta en <strong>${opts.businessName}</strong>.</p>
    <p style="text-align:center;margin:22px 0;">
      <a href="${opts.link}" style="background:#2563eb;color:#fff;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:10px;display:inline-block;">
        Cambiar mi contraseña
      </a>
    </p>
    <p style="color:#6b7280;font-size:13px;">Si el botón no funciona, copiá y pegá este enlace en tu navegador:</p>
    <p style="word-break:break-all;font-size:12px;color:#2563eb;">${opts.link}</p>
    <p style="color:#9ca3af;font-size:12px;margin-top:16px;">Este enlace es de un solo uso y vence pronto. Si no solicitaste el cambio, ignorá este correo.</p>`;
  return layout('Restablecer contraseña', body, opts.businessName);
}

// ─── 5) Comprobante de alta / uso del sistema (nuevo negocio) ───────────────────
export function newBusinessEmailHtml(opts: {
  businessName: string;
  ownerName?: string;
  ownerEmail?: string;
  planName?: string;
  billingCycle?: string;
  price?: number;
  startDate?: string | null;
  nextBilling?: string | null;
  maxUsers?: number | null;
  maxProducts?: number | null;
  maxOrders?: number | null;
  features?: string[];
}): string {
  const cycle = opts.billingCycle === 'yearly' ? 'anual' : opts.billingCycle === 'lifetime' ? 'vitalicio' : 'mensual';
  const body = `
    <p>¡Bienvenido a bordo${opts.ownerName ? `, ${opts.ownerName}` : ''}!</p>
    <p>Tu negocio <strong>${opts.businessName}</strong> ya está activo en el sistema. Este es el comprobante de alta.</p>
    ${detailRows([
      ['Negocio', opts.businessName],
      ['Responsable', opts.ownerName ?? undefined],
      ['Correo', opts.ownerEmail ?? undefined],
      ['Plan', opts.planName ? `${opts.planName} (${cycle})` : undefined],
      ['Precio', opts.price != null ? `${fmtCRC(opts.price)} / ${cycle}` : undefined],
      ['Inicio', fmtDate(opts.startDate)],
      ['Próximo cobro', fmtDate(opts.nextBilling)],
      ['Usuarios incluidos', opts.maxUsers != null ? String(opts.maxUsers) : '∞'],
      ['Productos', opts.maxProducts != null ? String(opts.maxProducts) : '∞'],
      ['Órdenes', opts.maxOrders != null ? String(opts.maxOrders) : '∞'],
    ])}
    ${opts.features && opts.features.length ? `
      <p style="margin:14px 0 6px;font-weight:700;">Tu plan incluye:</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151;">
        ${opts.features.map(f => `<tr><td style="padding:4px 0;"><span style="color:#059669;font-weight:800;">✓</span> &nbsp;${f}</td></tr>`).join('')}
      </table>` : ''}
    <p style="color:#6b7280;font-size:14px;">¡Gracias por elegirnos! Cualquier duda, respondé este correo.</p>`;
  return layout('Comprobante de alta', body, opts.businessName);
}
