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

/**
 * Traduce los errores de Meta a algo que se pueda accionar.
 *
 * Meta contesta con textos como «authentication error» o números de código que
 * no dicen qué hacer. Cada uno tiene una solución distinta —renovar el token,
 * aprobar una plantilla, registrar el número de prueba— y sin traducirlos todos
 * se veían igual: «WhatsApp no funciona».
 */
export function traducirErrorMeta(data: any, status: number): string {
  const e = data?.error ?? {};
  const code = Number(e?.code ?? 0);
  const texto = String(e?.message ?? '').trim();

  if (code === 190 || status === 401 || /authentication|access token|oauth/i.test(texto)) {
    return 'El token de Meta venció o no es válido. Generá uno PERMANENTE (usuario de sistema en '
      + 'Meta Business) y ponelo en WHATSAPP_TOKEN. Los tokens temporales duran 24 horas.';
  }
  if (code === 132000 || code === 132001 || /template/i.test(texto)) {
    return `La plantilla no existe o no está aprobada en WhatsApp Manager (${texto || 'sin detalle'}). `
      + 'Por la Cloud API los avisos automáticos SOLO salen con plantillas aprobadas.';
  }
  if (code === 131030) {
    return 'El número destino no está en la lista de números de prueba de Meta. '
      + 'Mientras la app esté en modo prueba, solo se puede escribir a los números registrados ahí.';
  }
  if (code === 131047 || code === 131051) {
    return 'Meta no permite escribirle a ese número ahora (ventana de 24 h cerrada). '
      + 'Con plantillas aprobadas sí se puede iniciar la conversación.';
  }
  if (code === 100) {
    return `Meta rechazó los datos del mensaje: ${texto || 'parámetro inválido'}.`;
  }
  return texto || `HTTP ${status}`;
}

/**
 * ¿El token de Meta sirve? Se pregunta por el número configurado.
 *
 * Permite saber que el token venció SIN mandarle un mensaje a nadie, que es lo
 * que antes obligaba a probar a ciegas contra el teléfono de un cliente.
 */
export async function verificarTokenMeta(): Promise<{ ok: boolean; detalle: string }> {
  if (!whatsappEnabled()) return { ok: false, detalle: 'Falta WHATSAPP_TOKEN en el servidor.' };
  try {
    const url = `https://graph.facebook.com/${apiVersion()}/${phoneNumberId()}`
      + '?fields=display_phone_number,verified_name,quality_rating';
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, detalle: traducirErrorMeta(data, res.status) };
    return {
      ok: true,
      detalle: `Token válido · número ${data?.display_phone_number ?? phoneNumberId()}`
        + `${data?.verified_name ? ` (${data.verified_name})` : ''}`,
    };
  } catch (e: any) {
    return { ok: false, detalle: `No se pudo consultar a Meta: ${e?.message ?? 'error de red'}` };
  }
}

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
    if (!res.ok) return { ok: false, error: traducirErrorMeta(data, res.status) };
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
