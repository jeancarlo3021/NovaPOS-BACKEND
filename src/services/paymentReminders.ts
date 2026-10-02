import { db } from '../db/client.js';
import { notifyPaymentDue, notifyGracePeriod } from './whatsappNotify.js';
import { DIAS_DE_GRACIA, graciaRestante } from '../utils/gracia.js';

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

/** Días CALENDARIO que faltan: 0 = vence hoy. */
function diasHasta(endsAt: string): number {
  const hoy = new Date(`${diaCR(new Date())}T00:00:00Z`).getTime();
  const fin = new Date(`${diaCR(endsAt)}T00:00:00Z`).getTime();
  return Math.round((fin - hoy) / 86_400_000);
}

export interface ResumenAvisos {
  revisados: number;
  enviados: Array<{ tenant_id: string; dias: number; gracia?: number }>;
  ya_enviados: number;
  sin_enviar: Array<{ tenant_id: string; dias: number; motivo: string }>;
}

export async function enviarAvisosDeCobro(opts: { dryRun?: boolean } = {}): Promise<ResumenAvisos> {
  const res: ResumenAvisos = { revisados: 0, enviados: [], ya_enviados: 0, sin_enviar: [] };

  /**
   * Las que vencen pronto Y las que ya vencieron pero siguen en gracia.
   *
   * El extremo de abajo era «ayer», así que una suscripción vencida se caía de
   * la consulta al día siguiente y no había forma de avisar durante la gracia.
   */
  const limite = new Date(Date.now() + 8 * 86_400_000).toISOString();
  const desde = new Date(Date.now() - (DIAS_DE_GRACIA + 1) * 86_400_000).toISOString();
  const { data: subs } = await db.from('subscriptions')
    .select('tenant_id, ends_at')
    .eq('status', 'active')
    .not('ends_at', 'is', null)
    .lte('ends_at', limite)
    .gte('ends_at', desde);

  const candidatos = (subs ?? []) as any[];
  if (candidatos.length === 0) return res;

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
