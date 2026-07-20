/**
 * Cliente de WhatsApp Cloud API (Meta) — ColónClick.
 *
 * Modelo: UN SOLO número ColónClick para todos los tenants (no Embedded Signup).
 *  - Token de acceso permanente en WHATSAPP_TOKEN (secreto, solo backend).
 *  - Phone Number ID en WHATSAPP_PHONE_ID (default: número de la app Colón Click).
 *  - Los mensajes proactivos DEBEN usar plantillas aprobadas por Meta (Utility).
 *
 * Envío: POST https://graph.facebook.com/{version}/{phoneNumberId}/messages
 */

const DEFAULT_PHONE_ID = '1179574238578851';   // Colón Click (Phone Number ID)
const DEFAULT_VERSION = 'v21.0';

function apiVersion(): string {
  return (process.env.WHATSAPP_API_VERSION || DEFAULT_VERSION).trim();
}
function phoneNumberId(): string {
  return (process.env.WHATSAPP_PHONE_ID || DEFAULT_PHONE_ID).trim();
}
function token(): string {
  return (process.env.WHATSAPP_TOKEN || '').trim();
}

/** ¿Está configurado el envío por WhatsApp? (hay token). */
export function whatsappEnabled(): boolean {
  return token().length > 0;
}

/**
 * Normaliza un teléfono a formato E.164 sin '+' (lo que espera la API).
 * Costa Rica: 8 dígitos → se antepone 506. Si ya trae código de país, se respeta.
 */
export function normalizePhone(raw: string | null | undefined): string {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  // Quita ceros/00 iniciales de marcado internacional.
  d = d.replace(/^0+/, '');
  if (d.length === 8) d = '506' + d;               // número CR local
  return d;
}

export interface WaResult { ok: boolean; id?: string; error?: string; skipped?: boolean }

/** Llamada base a la API de mensajes. */
async function sendMessage(to: string, payload: Record<string, any>): Promise<WaResult> {
  if (!whatsappEnabled()) return { ok: false, skipped: true, error: 'WhatsApp no configurado (falta WHATSAPP_TOKEN)' };
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, skipped: true, error: 'Teléfono destino vacío o inválido' };

  const url = `https://graph.facebook.com/${apiVersion()}/${phoneNumberId()}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, ...payload }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || data?.error?.error_data?.details || `HTTP ${res.status}`;
      return { ok: false, error: String(msg) };
    }
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Error de red al enviar WhatsApp' };
  }
}

/**
 * Envía una plantilla aprobada.
 * @param to        teléfono destino (se normaliza)
 * @param name      nombre exacto de la plantilla en WhatsApp Manager
 * @param bodyVars  valores para los {{1}}, {{2}}, ... del cuerpo (en orden)
 * @param lang      código de idioma de la plantilla (default 'es')
 */
export function sendTemplate(to: string, name: string, bodyVars: (string | number)[] = [], lang = 'es'): Promise<WaResult> {
  const components = bodyVars.length
    ? [{ type: 'body', parameters: bodyVars.map(v => ({ type: 'text', text: String(v) })) }]
    : [];
  return sendMessage(to, {
    type: 'template',
    template: { name, language: { code: lang }, ...(components.length ? { components } : {}) },
  });
}

/** Envía texto libre (SOLO válido dentro de la ventana de 24h de servicio). */
export function sendText(to: string, body: string): Promise<WaResult> {
  return sendMessage(to, { type: 'text', text: { preview_url: false, body } });
}
