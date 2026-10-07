import { db } from '../db/client.js';
import { notifyPaymentDue, notifyGracePeriod } from './whatsappNotify.js';
import { DIAS_DE_GRACIA, graciaRestante } from '../utils/gracia.js';
import { esVitalicio } from '../utils/planCiclo';

/**
 * Avisos automáticos de cobro por WhatsApp.
 *
 * Son dos tandas:
 *
 *   ANTES de vencer — a los 7, 4, 2 y 1 días. El primero avisa con tiempo y los
 *   últimos aprietan cerca de la fecha.
 *
 *   DESPUÉS de vencer — TODOS LOS DÍAS mientras corre el tiempo de gracia,
 *   diciendo cuántos días quedan para que el sistema deje de funcionar. Antes
 *   los avisos se callaban justo el día del vencimiento: el sistema seguía
 *   andando unos días más y el negocio no se enteraba de nada, hasta que un
 *   lunes a las 7 de la mañana no podía facturar con el local abierto.
 *
 * Cada aviso queda registrado en `wa_payment_reminders`. Sin eso, el proceso
 * —que corre cada pocos minutos— repetiría el mismo mensaje todo el día. Los de
 * gracia se anotan con el día en NEGATIVO (0 = venció hoy, −3 = hace tres días),
 * así la misma clave única da exactamente un mensaje por día.
 */
export const UMBRALES = [7, 4, 2, 1];

/** Fecha (solo el día) en Costa Rica. Comparar con horas corre los umbrales. */
const diaCR = (d: Date | string): string =>
  new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });

/**
 * HORARIO EN EL QUE SE PUEDE ESCRIBIR AL CLIENTE.
 *
 * El trabajo programado corre cada pocos minutos, y el aviso del día salía en la
 * PRIMERA corrida después de la medianoche: al negocio le llegaba un WhatsApp de
 * cobro a las 12 de la noche. Además de molesto, a esa hora nadie lo atiende y el
 * aviso se pierde entre las notificaciones del día siguiente.
 *
 * Fuera de la ventana no se manda nada y no se marca nada: el aviso queda
 * pendiente y sale en la primera corrida de la mañana. El tope de la tarde existe
 * por lo mismo que el de la mañana: si el proceso estuvo caído todo el día, es
 * mejor escribir mañana a las 8 que hoy a las 11 de la noche.
 */
const HORA_DESDE = Math.min(23, Math.max(0, Number(process.env.AVISOS_HORA_DESDE ?? 8)));
const HORA_HASTA = Math.min(23, Math.max(0, Number(process.env.AVISOS_HORA_HASTA ?? 20)));

/** Hora de Costa Rica (0-23), sin depender de la zona del servidor. */
export function horaCR(d = new Date()): number {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Costa_Rica', hour: 'numeric', hourCycle: 'h23',
  }).format(d);
  return Number(h) % 24;
}

/** ¿Es hora de escribirle al cliente? */
export function enHorarioDeAvisos(d = new Date()): boolean {
  const h = horaCR(d);
  return h >= HORA_DESDE && h <= HORA_HASTA;
}

/** Días CALENDARIO que faltan: 0 = vence hoy. */
function diasHasta(endsAt: string): number {
  const hoy = new Date(`${diaCR(new Date())}T00:00:00Z`).getTime();
  const fin = new Date(`${diaCR(endsAt)}T00:00:00Z`).getTime();
  return Math.round((fin - hoy) / 86_400_000);
}

export interface ResumenAvisos {
  /** Hora de Costa Rica en la que se evaluó, para poder explicar un «no salió». */
  hora_cr?: number;
  /** Se saltó porque está fuera del horario de avisos. */
  fuera_de_horario?: boolean;
  revisados: number;
  enviados: Array<{ tenant_id: string; dias: number; gracia?: number }>;
  ya_enviados: number;
  sin_enviar: Array<{ tenant_id: string; dias: number; motivo: string }>;
}

export async function enviarAvisosDeCobro(
  opts: { dryRun?: boolean; ignorarHorario?: boolean } = {},
): Promise<ResumenAvisos> {
  const res: ResumenAvisos = {
    hora_cr: horaCR(), revisados: 0, enviados: [], ya_enviados: 0, sin_enviar: [],
  };

  /**
   * Fuera del horario no se manda NI se marca.
   *
   * Es importante que no se marque: la marca es lo que impide repetir el aviso, y
   * si se pusiera a medianoche el aviso de ese día ya no saldría nunca —el cliente
   * se quedaría sin enterarse—. Así, a las 8 de la mañana la corrida lo encuentra
   * pendiente y lo manda.
   *
   * `ignorarHorario` existe para poder forzarlo a mano desde el panel.
   */
  if (!opts.ignorarHorario && !opts.dryRun && !enHorarioDeAvisos()) {
    res.fuera_de_horario = true;
    return res;
  }

  /**
   * Las que vencen pronto Y las que ya vencieron pero siguen en gracia.
   *
   * El extremo de abajo era «ayer», así que una suscripción vencida se caía de
   * la consulta al día siguiente y no había forma de avisar durante la gracia.
   */
  const limite = new Date(Date.now() + 8 * 86_400_000).toISOString();
  const desde = new Date(Date.now() - (DIAS_DE_GRACIA + 1) * 86_400_000).toISOString();
  const { data: subs } = await db.from('subscriptions')
    .select('tenant_id, ends_at, plan_id')
    .eq('status', 'active')
    .not('ends_at', 'is', null)
    .lte('ends_at', limite)
    .gte('ends_at', desde);

  let candidatos = (subs ?? []) as any[];
  if (candidatos.length === 0) return res;

  /**
   * Un plan VITALICIO no se cobra, aunque la suscripción traiga fecha.
   *
   * Varias suscripciones de planes vitalicios quedaron con un `ends_at` viejo,
   * de cuando la fecha se calculaba sin mirar el ciclo. Con eso, el día que esa
   * fecha llegara se les iba un aviso de cobro a clientes que no tienen nada
   * que pagar. El ciclo del plan manda sobre la fecha guardada.
   */
  const planIds = [...new Set(candidatos.map(s => s.plan_id).filter(Boolean))];
  if (planIds.length > 0) {
    const { data: planes } = await db.from('subscription_plans')
      .select('id, billing_cycle').in('id', planIds);
    const vitalicios = new Set((planes ?? [])
      .filter((p: any) => esVitalicio(p.billing_cycle)).map((p: any) => String(p.id)));
    if (vitalicios.size > 0)
      candidatos = candidatos.filter(s => !vitalicios.has(String(s.plan_id)));
    if (candidatos.length === 0) return res;
  }

  // Las DEMOS no reciben avisos de cobro: no hay nada que cobrarles, y su
  // vencimiento se maneja aparte (bloqueo y borrado).
  const ids = [...new Set(candidatos.map(s => s.tenant_id))];
  const activos = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: ts } = await db.from('tenants')
      .select('id, name, is_demo, status').in('id', ids.slice(i, i + 200));
    for (const t of (ts ?? []) as any[]) activos.set(String(t.id), t);
  }

  for (const s of candidatos) {
    const t = activos.get(String(s.tenant_id));
    if (!t || t.is_demo === true || t.status !== 'active') continue;

    const dias = diasHasta(s.ends_at);
    /**
     * ¿Le toca aviso hoy?
     *
     * Antes de vencer, solo en los umbrales. Desde el día del vencimiento y
     * hasta que se acaba la gracia, TODOS los días.
     */
    const gracia = dias <= 0 ? graciaRestante(dias) : null;
    const leToca = dias > 0 ? UMBRALES.includes(dias) : gracia! >= 0;
    if (!leToca) continue;
    res.revisados++;

    const vence = diaCR(s.ends_at);
    if (opts.dryRun) {
      res.enviados.push({ tenant_id: s.tenant_id, dias, ...(gracia != null ? { gracia } : {}) });
      continue;
    }

    /**
     * Se APARTA el aviso antes de mandarlo.
     *
     * La clave única de la tabla es lo que garantiza que no salga dos veces,
     * incluso si dos ejecuciones coinciden. Si el envío después falla, se borra
     * la marca para que el siguiente intento lo reintente.
     */
    const { error: eMarca } = await db.from('wa_payment_reminders')
      .insert({ tenant_id: s.tenant_id, ends_at: vence, days: dias });
    if (eMarca) {
      if (/duplicate|unique/i.test(eMarca.message)) { res.ya_enviados++; continue; }
      res.sin_enviar.push({ tenant_id: s.tenant_id, dias, motivo: eMarca.message });
      continue;
    }

    const r = gracia != null
      ? await notifyGracePeriod(s.tenant_id, gracia)
      : await notifyPaymentDue(s.tenant_id, dias);
    if (r.ok) {
      res.enviados.push({ tenant_id: s.tenant_id, dias, ...(gracia != null ? { gracia } : {}) });
    } else {
      // No salió: se suelta la marca para poder reintentarlo.
      await db.from('wa_payment_reminders')
        .delete().eq('tenant_id', s.tenant_id).eq('ends_at', vence).eq('days', dias);
      res.sin_enviar.push({ tenant_id: s.tenant_id, dias, motivo: r.error ?? 'sin detalle' });
    }
  }
  return res;
}
