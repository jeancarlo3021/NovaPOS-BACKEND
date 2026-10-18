/**
 * Notificaciones de negocio por WhatsApp (ColónClick → sus clientes/negocios).
 *
 * Centraliza los 3 casos de uso y los nombres/plantillas en un solo lugar:
 *   1. recordatorio_pago       — la suscripción a ColónClick está por vencer
 *   1b. tiempo_de_gracia       — ya venció y corre la gracia (aviso diario)
 *   2. documentos_por_acabarse — la cuota de comprobantes electrónicos está baja
 *   3. error_facturacion       — falló la emisión de un comprobante electrónico
 *
 * Todos van al WhatsApp del DUEÑO del negocio (settings.config.emisor_phone,
 * con fallback al teléfono del usuario dueño). Requieren plantillas aprobadas
 * en WhatsApp Manager con esos nombres exactos.
 */
import { db } from '../db/client.js';
import { configEfectiva } from './feCompartida.js';
import { sendTemplate, whatsappEnabled, normalizePhone, type WaResult } from './whatsapp.js';
import { sendViaWorker, workerEnabled } from './whatsappWorker.js';

export interface BizContact { phone: string; name: string }

/**
 * Deja constancia de los avisos que NO salieron.
 *
 * Quien llama a estas funciones lo hace con `void … .catch(() => {})` para no
 * frenar una venta por un aviso. El costo era que un aviso que no se mandaba
 * —sin teléfono, worker caído, plantilla sin aprobar— no dejaba rastro en
 * ningún lado, y desde afuera parecía que WhatsApp «no funciona» sin más.
 */
function registrar(caso: string, tenantId: string, r: WaResult): WaResult {
  if (!r.ok) {
    console.warn(`[wa ${caso}] negocio ${tenantId}: `
      + `${r.skipped ? 'OMITIDO' : 'FALLÓ'} — ${r.error ?? 'sin detalle'}`);
  }
  return r;
}

/** Teléfono + nombre del negocio (para dirigir los avisos al dueño). */
/**
 * DÓNDE SE BUSCA EL TELÉFONO DEL NEGOCIO, y por qué en ese orden.
 *
 * El número puede estar en cinco lugares según por dónde lo haya cargado quien
 * configuró el negocio. Se buscan en este orden, y el orden importa: el
 * primero que aparezca es al que se le escribe.
 *
 *   1. `general.notify_phone` — el campo DEDICADO a avisos; es donde lo
 *      guarda el Panel Admin al crear el negocio. Es el que manda.
 *   2. `general.emisor_phone` — variante vieja del mismo campo.
 *   3. `electronic-invoice.notify_phone` / `.emisor_phone` — los datos de
 *      Hacienda (incluye los heredados del principal, si es una actividad).
 *   4. `general.phone` — **el teléfono del negocio**, el que se escribe en
 *      Configuración → General. ESTE FALTABA.
 *   5. `users.phone` del dueño, como último recurso.
 *
 * ── El error que esto corrige ──────────────────────────────────────────────
 * Faltaba el punto 4, que es justamente donde un negocio pone su número
 * cuando se lo piden como «Teléfono del negocio». Quien lo cargaba ahí no
 * recibía ningún aviso de cobro y no había forma de saber por qué: el envío se
 * salta en silencio cuando no encuentra teléfono.
 *
 * Los puntos 1 a 3 quedan EXACTAMENTE como estaban, a propósito: así ningún
 * negocio al que ya le llegaban los avisos cambia de número por este arreglo.
 */
export async function businessContact(tenantId: string): Promise<BizContact> {
  let phone = '';
  let name = '';
  let fuente = '';
  /** Guarda el primer teléfono válido que aparezca, y de dónde salió. */
  const tomar = (valor: any, de: string) => {
    if (phone) return;
    const n = normalizePhone(valor);
    if (n) { phone = n; fuente = de; }
  };

  // 1 y 2 — configuración general (donde el panel guarda el número de avisos).
  let general: any = {};
  try {
    const { data: s } = await db.from('settings').select('config')
      .eq('tenant_id', tenantId).eq('type', 'general').maybeSingle();
    general = (s as any)?.config ?? {};
    tomar(general.notify_phone, 'general.notify_phone');
    tomar(general.emisor_phone, 'general.emisor_phone');
    name = String(general.emisor_commercial_name || general.emisor_name || '').trim();
  } catch { /* ignore */ }

  // 3 — datos de facturación electrónica (con lo heredado del principal).
  if (!phone || !name) {
    try {
      const { data: fe } = await db.from('settings').select('config')
        .eq('tenant_id', tenantId).eq('type', 'electronic-invoice').maybeSingle();
      const f: any = await configEfectiva(tenantId, (fe as any)?.config ?? {});
      tomar(f.notify_phone, 'fe.notify_phone');
      tomar(f.emisor_phone, 'fe.emisor_phone');
      if (!name) name = String(f.emisor_commercial_name || f.emisor_name || '').trim();
    } catch { /* ignore */ }
  }

  // 4 — el teléfono del negocio de Configuración → General.
  tomar(general.phone, 'general.phone');
  tomar(general.whatsapp ?? general.whatsapp_phone, 'general.whatsapp');
  if (!name) name = String(general.businessName ?? '').trim();

  const { data: t } = await db.from('tenants').select('name, owner_id').eq('id', tenantId).maybeSingle();
  if (!name) name = String((t as any)?.name ?? 'su negocio').trim();

  // 5 — último recurso: el teléfono del usuario dueño.
  if (!phone) {
    const ownerId = (t as any)?.owner_id;
    if (ownerId) {
      const { data: u } = await db.from('users').select('phone').eq('id', ownerId).maybeSingle();
      tomar((u as any)?.phone, 'users.phone');
    }
  }

  // Queda en el registro de dónde salió: cuando alguien reclama que no le llegó
  // el aviso, lo primero que hay que saber es a qué número se le escribió.
  if (phone) console.log(`[wa] negocio ${tenantId}: teléfono ${phone} (${fuente})`);
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

/**
 * ENVÍO DE UN ANUNCIO: texto libre, a un negocio.
 *
 * Un anuncio es distinto de un recordatorio: el texto cambia cada vez —un
 * módulo nuevo, un cambio de precio— y no hay forma de tener una plantilla
 * aprobada por Meta para cada cosa que se vaya a contar.
 *
 * Por eso esto SOLO sale por el worker de WhatsApp (el del código QR). Si no
 * está conectado, NO se intenta por la Cloud API: Meta rechaza el texto libre
 * fuera de la ventana de 24 horas, y el resultado sería una tanda de envíos
 * fallidos que, repetida, termina en una cuenta marcada. Vale más decir que
 * no se puede mandar que mandar mal.
 */
export async function enviarAnuncio(phone: string, texto: string): Promise<WaResult> {
  if (!phone) return { ok: false, skipped: true, error: 'El negocio no tiene teléfono registrado' };
  if (!workerEnabled()) {
    return {
      ok: false, skipped: true,
      error: 'El worker de WhatsApp (el del código QR) no está conectado. Un anuncio es texto '
        + 'libre, y por la Cloud API de Meta eso solo se puede mandar dentro de las 24 horas '
        + 'posteriores a que el cliente escriba. Conectá el worker en la pestaña de WhatsApp.',
    };
  }
  return sendViaWorker(phone, texto);
}

/** 1. Recordatorio de pago de la suscripción. */
export async function notifyPaymentDue(tenantId: string, days: number): Promise<WaResult> {
  const { phone, name } = await businessContact(tenantId);
  if (!phone) return registrar('recordatorio_pago', tenantId, { ok: false, skipped: true, error: 'el negocio no tiene teléfono configurado' });
  const cuando = days <= 0 ? 'hoy' : days === 1 ? 'mañana' : `en ${days} días`;
  const text = `⏰ *ColónClick*\n\nHola ${name}, tu suscripción vence ${cuando}. `
    + `Renová a tiempo para no perder el servicio (POS, facturación, etc.).\n\n¡Gracias por confiar en ColónClick!`;
  return registrar('recordatorio_pago', tenantId,
    await deliver(phone, text, () => sendTemplate(phone, 'recordatorio_pago', [name, days])));
}

/**
 * 1b. TIEMPO DE GRACIA: el aviso diario de después del vencimiento.
 *
 * Los recordatorios de cobro (7, 4, 2 y 1 días) se callaban en el momento en que
 * el cliente más necesita enterarse: el día que vence. Después de eso el sistema
 * sigue andando unos días y el negocio no se da cuenta de nada… hasta que un
 * lunes a las 7 de la mañana no puede facturar, con el local abierto.
 *
 * Este sale TODOS LOS DÍAS mientras corre la gracia, y dice exactamente cuántos
 * días quedan. Al llegar a cero avisa que es hoy.
 */
export async function notifyGracePeriod(tenantId: string, diasRestantes: number): Promise<WaResult> {
  const { phone, name } = await businessContact(tenantId);
  if (!phone) return registrar('tiempo_de_gracia', tenantId, { ok: false, skipped: true, error: 'el negocio no tiene teléfono configurado' });
  const d = Math.max(0, Math.round(diasRestantes));
  const cuanto = d === 0 ? '*hoy mismo*'
    : d === 1 ? 'te queda *1 día*'
    : `te quedan *${d} días*`;
  const text = `⏳ *ColónClick*

`
    + `${name}: ya pasó el tiempo de aviso. Ahora corre el *tiempo de gracia*: `
    + `${d === 0 ? 'hoy mismo el sistema deja de funcionar' : `${cuanto} para que el sistema deje de funcionar`}.

`
    + `Cuando se acabe vas a poder *ver* tu información, pero no vender ni facturar.

`
    + `Para seguir trabajando, ponete al día con el pago. Si ya pagaste, escribinos y lo activamos.`;
  return registrar('tiempo_de_gracia', tenantId,
    await deliver(phone, text, () => sendTemplate(phone, 'tiempo_de_gracia', [name, d])));
}

/** 2. Aviso de comprobantes por acabarse. */
export async function notifyQuotaLow(tenantId: string, remaining: number, included: number): Promise<WaResult> {
  const { phone, name } = await businessContact(tenantId);
  if (!phone) return registrar('cuota_baja', tenantId, { ok: false, skipped: true, error: 'el negocio no tiene teléfono configurado' });
  const text = `📄 *ColónClick — Comprobantes electrónicos*\n\n${name}: te quedan *${remaining}* de ${included} comprobantes de tu plan. `
    + `Cuando se acaben no podrás emitir facturas/tiquetes electrónicos. Considerá ampliar tu plan.`;
  return registrar('cuota_baja', tenantId,
    await deliver(phone, text, () => sendTemplate(phone, 'documentos_por_acabarse', [name, remaining, included])));
}

/** 3. Aviso de error en la facturación electrónica. */
export async function notifyFeError(tenantId: string, docLabel: string, reason: string): Promise<WaResult> {
  const { phone, name } = await businessContact(tenantId);
  if (!phone) return registrar('error_fe', tenantId, { ok: false, skipped: true, error: 'el negocio no tiene teléfono configurado' });
  const motivo = String(reason || 'Error desconocido').slice(0, 400);
  const text = `⚠️ *ColónClick — Facturación electrónica*\n\n${name}: falló la emisión de *${docLabel || 'un comprobante'}*.\n\n`
    + `Motivo: ${motivo}\n\nRevisá los datos e intentá de nuevo. Si persiste, contactá a soporte.`;
  return registrar('error_fe', tenantId,
    await deliver(phone, text, () => sendTemplate(phone, 'error_facturacion', [name, docLabel || 'comprobante', motivo])));
}
