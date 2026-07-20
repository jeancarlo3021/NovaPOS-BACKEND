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

export interface BizContact { phone: string; name: string }

/** Teléfono + nombre del negocio (para dirigir los avisos al dueño). */
export async function businessContact(tenantId: string): Promise<BizContact> {
  let phone = '';
  let name = '';
  try {
    const { data: s } = await db.from('settings').select('config')
      .eq('tenant_id', tenantId).eq('type', 'general').maybeSingle();
    const cfg: any = (s as any)?.config ?? {};
    phone = normalizePhone(cfg.emisor_phone);
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

/** 1. Recordatorio de pago de la suscripción. */
export async function notifyPaymentDue(tenantId: string, days: number): Promise<WaResult> {
  if (!whatsappEnabled()) return { ok: false, skipped: true };
  const { phone, name } = await businessContact(tenantId);
  if (!phone) return { ok: false, skipped: true, error: 'Sin teléfono' };
  return sendTemplate(phone, 'recordatorio_pago', [name, days]);
}

/** 2. Aviso de comprobantes por acabarse. */
export async function notifyQuotaLow(tenantId: string, remaining: number, included: number): Promise<WaResult> {
  if (!whatsappEnabled()) return { ok: false, skipped: true };
  const { phone, name } = await businessContact(tenantId);
  if (!phone) return { ok: false, skipped: true, error: 'Sin teléfono' };
  return sendTemplate(phone, 'documentos_por_acabarse', [name, remaining, included]);
}

/** 3. Aviso de error en la facturación electrónica. */
export async function notifyFeError(tenantId: string, docLabel: string, reason: string): Promise<WaResult> {
  if (!whatsappEnabled()) return { ok: false, skipped: true };
  const { phone, name } = await businessContact(tenantId);
  if (!phone) return { ok: false, skipped: true, error: 'Sin teléfono' };
  const motivo = String(reason || 'Error desconocido').slice(0, 250);
  return sendTemplate(phone, 'error_facturacion', [name, docLabel || 'comprobante', motivo]);
}
