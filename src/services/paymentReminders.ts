import { db } from '../db/client.js';
import { notifyPaymentDue } from './whatsappNotify.js';

/**
 * Avisos automáticos de cobro por WhatsApp.
 *
 * Se manda cuando faltan 7, 4, 2 y 1 días para el vencimiento: el primero avisa
 * con tiempo y los últimos aprietan cerca de la fecha. Antes existía el envío
 * masivo pero había que dispararlo a mano, así que en la práctica no salía.
 *
 * Cada aviso queda registrado en `wa_payment_reminders`. Sin eso, el proceso
 * —que corre cada pocos minutos— repetiría el mismo mensaje todo el día.
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
  enviados: Array<{ tenant_id: string; dias: number }>;
  ya_enviados: number;
  sin_enviar: Array<{ tenant_id: string; dias: number; motivo: string }>;
}

export async function enviarAvisosDeCobro(opts: { dryRun?: boolean } = {}): Promise<ResumenAvisos> {
  const res: ResumenAvisos = { revisados: 0, enviados: [], ya_enviados: 0, sin_enviar: [] };

  // Suscripciones activas que vencen dentro de la ventana más amplia (7 días).
  const limite = new Date(Date.now() + 8 * 86_400_000).toISOString();
  const { data: subs } = await db.from('subscriptions')
    .select('tenant_id, ends_at')
    .eq('status', 'active')
    .not('ends_at', 'is', null)
    .lte('ends_at', limite)
    .gte('ends_at', new Date(Date.now() - 86_400_000).toISOString());

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
    if (!UMBRALES.includes(dias)) continue;
    res.revisados++;

    const vence = diaCR(s.ends_at);
    if (opts.dryRun) { res.enviados.push({ tenant_id: s.tenant_id, dias }); continue; }

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

    const r = await notifyPaymentDue(s.tenant_id, dias);
    if (r.ok) {
      res.enviados.push({ tenant_id: s.tenant_id, dias });
    } else {
      // No salió: se suelta la marca para poder reintentarlo.
      await db.from('wa_payment_reminders')
        .delete().eq('tenant_id', s.tenant_id).eq('ends_at', vence).eq('days', dias);
      res.sin_enviar.push({ tenant_id: s.tenant_id, dias, motivo: r.error ?? 'sin detalle' });
    }
  }
  return res;
}
