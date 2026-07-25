/**
 * Notificaciones de negocio por WhatsApp (ColónClick → sus clientes/negocios).
 *
 * Centraliza los 3 casos de uso y los nombres/plantillas en un solo lugar:
 *   1. recordatorio_pago       — la suscripción a ColónClick está por vencer
 *   2. documentos_por_acabarse — la cuota de comprobantes electrónicos está baja
 *   3. error_facturacion       — falló la emisión de un comprobante electrónico
 *
 * Todos van al WhatsApp del DUEÑO del negocio (settings.config.emisor_phone,
 * con fallback al teléfono del usuario dueño). Requieren plantillas aprobadas
 * en WhatsApp Manager con esos nombres exactos.
 */
import { db } from '../db/client.js';
import { sendTemplate, whatsappEnabled, normalizePhone, type WaResult } from './whatsapp.js';
import { sendViaWorker, workerEnabled } from './whatsappWorker.js';

export interface BizContact { phone: string; name: string }

/** Teléfono + nombre del negocio (para dirigir los avisos al dueño). */
export async function businessContact(tenantId: string): Promise<BizContact> {
  let phone = '';
  let name = '';
  try {
    const { data: s } = await db.from('settings').select('config')
      .eq('tenant_id', tenantId).eq('type', 'general').maybeSingle();
    const cfg: any = (s as any)?.config ?? {};
    // Preferimos el número DEDICADO a avisos (notify_phone) si está guardado;
    // si no, el teléfono del emisor.
    phone = normalizePhone(cfg.notify_phone || cfg.emisor_phone);
    name = String(cfg.emisor_commercial_name || cfg.emisor_name || '').trim();
  } catch { /* ignore */ }

  const { data: t } = await db.from('tenants').select('name, owner_id').eq('id', tenantId).maybeSingle();
  if (!name) name = String((t as any)?.name ?? 'su negocio').trim();

  // Fallback: teléfono del usuario dueño.
  if (!phone) {
    const ownerId = (t as any)?.owner_id;
    if (ownerId) {
      const { data: u } = await db.from('users').select('phone').eq('id', ownerId).maybeSingle();
      phone = normalizePhone((u as any)?.phone);
    }
  }
  return { phone, name };
}

// Canal de envío: si hay WORKER (número vinculado por QR) se usa TEXTO LIBRE por
// el worker (sin plantillas de Meta). Si no, se cae a la Cloud API con plantilla.
// Si no hay ninguno, se salta.
async function deliver(phone: string, workerText: string, template: () => WaResult | Promise<WaResult>): Promise<WaResult> {
  if (workerEnabled()) {
    const r = await sendViaWorker(phone, workerText);
    if (r.ok || r.skipped) return r;
    // Si el worker falló pero hay Cloud API, intentamos por ahí.
    if (whatsappEnabled()) return template();
    return r;
  }
  if (whatsappEnabled()) return template();
  return { ok: false, skipped: true };
}

/** 1. Recordatorio de pago de la suscripción. */
export async function notifyPaymentDue(tenantId: string, days: number): Promise<WaResult> {
  const { phone, name } = await businessContact(tenantId);
  if (!phone) return { ok: false, skipped: true, error: 'Sin teléfono' };
  const cuando = days <= 0 ? 'hoy' : days === 1 ? 'mañana' : `en ${days} días`;
  const text = `⏰ *ColónClick*\n\nHola ${name}, tu suscripción vence ${cuando}. `
    + `Renová a tiempo para no perder el servicio (POS, facturación, etc.).\n\n¡Gracias por confiar en ColónClick!`;
  return deliver(phone, text, () => sendTemplate(phone, 'recordatorio_pago', [name, days]));
}

/** 2. Aviso de comprobantes por acabarse. */
export async function notifyQuotaLow(tenantId: string, remaining: number, included: number): Promise<WaResult> {
  const { phone, name } = await businessContact(tenantId);
  if (!phone) return { ok: false, skipped: true, error: 'Sin teléfono' };
  const text = `📄 *ColónClick — Comprobantes electrónicos*\n\n${name}: te quedan *${remaining}* de ${included} comprobantes de tu plan. `
    + `Cuando se acaben no podrás emitir facturas/tiquetes electrónicos. Considerá ampliar tu plan.`;
  return deliver(phone, text, () => sendTemplate(phone, 'documentos_por_acabarse', [name, remaining, included]));
}

/** 3. Aviso de error en la facturación electrónica. */
export async function notifyFeError(tenantId: string, docLabel: string, reason: string): Promise<WaResult> {
  const { phone, name } = await businessContact(tenantId);
  if (!phone) return { ok: false, skipped: true, error: 'Sin teléfono' };
  const motivo = String(reason || 'Error desconocido').slice(0, 400);
  const text = `⚠️ *ColónClick — Facturación electrónica*\n\n${name}: falló la emisión de *${docLabel || 'un comprobante'}*.\n\n`
    + `Motivo: ${motivo}\n\nRevisá los datos e intentá de nuevo. Si persiste, contactá a soporte.`;
  return deliver(phone, text, () => sendTemplate(phone, 'error_facturacion', [name, docLabel || 'comprobante', motivo]));
}
