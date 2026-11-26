import { leerGlobal, guardarGlobal } from './globalSettings.js';
import { emailEnabled, sendEmail, leadEmailHtml } from './emailService.js';

/**
 * EL AVISO DE QUE ALGUIEN ESCRIBIÓ.
 *
 * ── El problema que resuelve ──────────────────────────────────────────────
 * El formulario de la página guardaba al interesado en `landing_leads` y ahí
 * se quedaba hasta que alguien se acordara de abrir el panel. El formulario
 * funcionaba perfecto y el cliente se perdía igual: a las dos horas ya llamó
 * a otro proveedor. Un lead que nadie ve a tiempo es casi lo mismo que no
 * tenerlo.
 *
 * ── Por qué los destinatarios se configuran y no se adivinan ──────────────
 * El sistema no tiene forma de saber a quién le toca atender los interesados:
 * puede ser el dueño, puede ser una persona de ventas, pueden ser tres.
 * Deducirlo de los usuarios con rol de dueño sonaría práctico y mandaría los
 * datos de contacto de un desconocido a correos que nadie eligió para eso.
 */

export const TIPO_AJUSTE = 'avisos_interesados';

export interface AjustesAviso {
  activo: boolean;
  /** A quiénes se les avisa. */
  correos: string[];
}

/** Un correo que al menos tiene forma de correo. */
const esCorreo = (s: unknown) =>
  /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(String(s ?? '').trim());

const DE_ENTORNO = () => String(process.env.LEADS_NOTIFY_EMAIL ?? '')
  .split(/[,;\s]+/).map(x => x.trim()).filter(esCorreo);

export async function leerAjustesAviso(): Promise<AjustesAviso & { de_entorno: boolean }> {
  const cfg = await leerGlobal<Partial<AjustesAviso>>(TIPO_AJUSTE);
  const guardados = (cfg?.correos ?? []).map(x => String(x).trim()).filter(esCorreo);
  if (guardados.length) {
    return { activo: cfg?.activo !== false, correos: guardados, de_entorno: false };
  }
  /* Respaldo por variable de entorno: sirve para que el aviso funcione desde
     el primer día, antes de que alguien entre al panel a configurarlo. */
  const entorno = DE_ENTORNO();
  return {
    activo: cfg?.activo !== false,
    correos: entorno,
    de_entorno: entorno.length > 0,
  };
}

export async function guardarAjustesAviso(entrada: any): Promise<AjustesAviso & { de_entorno: boolean }> {
  const correos = [...new Set(
    (Array.isArray(entrada?.correos) ? entrada.correos : String(entrada?.correos ?? '').split(/[,;\s]+/))
      .map((x: unknown) => String(x).trim().toLowerCase())
      .filter(esCorreo),
  )] as string[];

  if (entrada?.activo !== false && correos.length === 0) {
    throw new Error('Para avisar por correo hace falta al menos un correo válido. '
      + 'Si querés apagar el aviso, apagalo en vez de dejar la lista vacía: '
      + 'así queda claro que es a propósito y no un descuido.');
  }
  if (correos.length > 10) {
    throw new Error('Diez correos es el tope. Más que eso conviene una lista de distribución.');
  }

  const ok = await guardarGlobal(TIPO_AJUSTE, { activo: entrada?.activo !== false, correos });
  if (!ok) throw new Error('No se pudo guardar. ¿Falta correr la migración de global_settings?');
  return leerAjustesAviso();
}

export interface ResultadoAviso {
  enviado: boolean;
  to: string | null;
  error: string | null;
}

/**
 * MANDAR EL AVISO.
 *
 * Nunca lanza: devuelve qué pasó. Quien lo llama está atendiendo el
 * formulario de un visitante, y el interesado YA está guardado — hacer
 * fallar esa respuesta porque el correo no salió le mostraría un error a una
 * persona que hizo todo bien, y encima la invitaría a enviar otra vez y
 * duplicar el lead.
 *
 * El motivo del fallo se devuelve para GUARDARLO. Un aviso que falla en
 * silencio es la peor versión de esto: la pantalla dice que todo está bien
 * mientras los interesados se acumulan sin que nadie los llame.
 */
export async function avisarInteresado(lead: {
  contact_name: string;
  business_name?: string | null;
  phone?: string | null;
  email?: string | null;
  business_type?: string | null;
  notes?: string | null;
  origen?: string | null;
}, opts: { timeoutMs?: number } = {}): Promise<ResultadoAviso> {
  try {
    if (!emailEnabled()) {
      return { enviado: false, to: null, error: 'Correo no configurado en el servidor (falta RESEND_API_KEY).' };
    }
    const ajustes = await leerAjustesAviso();
    if (!ajustes.activo) return { enviado: false, to: null, error: 'El aviso por correo está apagado.' };
    if (!ajustes.correos.length) {
      return {
        enviado: false, to: null,
        error: 'No hay ningún correo configurado para recibir los avisos.',
      };
    }

    const cuando = new Date().toLocaleString('es-CR', {
      timeZone: 'America/Costa_Rica', dateStyle: 'long', timeStyle: 'short',
    });

    const envio = sendEmail({
      to: ajustes.correos,
      subject: `Nuevo interesado: ${String(lead.contact_name).slice(0, 60)}`
        + (lead.business_name ? ` · ${String(lead.business_name).slice(0, 40)}` : ''),
      html: leadEmailHtml({
        contactName: lead.contact_name,
        businessName: lead.business_name,
        phone: lead.phone,
        email: lead.email,
        businessType: lead.business_type,
        notes: lead.notes,
        origen: lead.origen,
        cuando,
      }),
      /* Responder el aviso le escribe A LA PERSONA, no al sistema. Es lo que
         convierte el correo en la forma de contestar y no solo de enterarse.
         Si no dejó correo no se pone nada: un `replyTo` vacío haría que la
         respuesta se perdiera sin avisar. */
      replyTo: lead.email && esCorreo(lead.email) ? String(lead.email).trim() : undefined,
    });

    /**
     * Con tope de tiempo.
     *
     * El visitante está esperando la respuesta del formulario. Si el servicio
     * de correo está lento, se corta y se guarda que no salió: el interesado
     * queda registrado igual y el panel muestra que hay un aviso pendiente.
     */
    const tope = opts.timeoutMs ?? 6_000;
    const resultado = await Promise.race([
      envio.then(() => 'ok' as const),
      new Promise<'tarde'>(r => setTimeout(() => r('tarde'), tope)),
    ]);

    if (resultado === 'tarde') {
      /* La promesa sigue viva y puede llegar a enviarse; se le pone un
         manejador para que un rechazo posterior no tumbe el proceso. */
      envio.catch(() => {});
      return {
        enviado: false, to: ajustes.correos.join(', '),
        error: `El servicio de correo no respondió en ${Math.round(tope / 1000)} s. `
          + 'Puede que el aviso llegue de todas formas.',
      };
    }
    return { enviado: true, to: ajustes.correos.join(', '), error: null };
  } catch (e: any) {
    return { enviado: false, to: null, error: String(e?.message ?? e).slice(0, 400) };
  }
}
