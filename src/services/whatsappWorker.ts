/**
 * Envío de WhatsApp por el WORKER (Baileys, número vinculado por QR).
 * A diferencia de la Cloud API, esto NO requiere plantillas aprobadas: manda
 * texto libre desde el número ColónClick vinculado.
 *
 * Env: WHATSAPP_WORKER_URL, WHATSAPP_WORKER_SECRET (mismos que usa el panel admin).
 */
import { normalizePhone, type WaResult } from './whatsapp.js';

export function workerEnabled(): boolean {
  return (process.env.WHATSAPP_WORKER_URL || '').trim().length > 0;
}

function base(): string {
  return (process.env.WHATSAPP_WORKER_URL || '').trim().replace(/\/+$/, '');
}

/** Envía un texto libre por el worker. Devuelve WaResult (compatible con whatsappNotify). */
export async function sendViaWorker(phone: string, text: string): Promise<WaResult> {
  const url = base();
  if (!url) return { ok: false, skipped: true, error: 'worker no configurado' };
  const to = normalizePhone(phone);
  if (!to) return { ok: false, skipped: true, error: 'sin teléfono' };
  try {
    const r = await fetch(url + '/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': (process.env.WHATSAPP_WORKER_SECRET || '').trim(),
      },
      body: JSON.stringify({ to, text }),
    });
    const data: any = await r.json().catch(() => ({}));
    if (r.ok && data?.ok) return { ok: true };
    // no_whatsapp / not_connected / unauthorized / HTTP xxx
    return { ok: false, error: data?.error || `HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'fetch_failed' };
  }
}
