import { db } from '../db/client.js';
import { leerGlobal } from './globalSettings.js';
import { costoFE } from './costoFE.js';
import { medirInfraestructura } from './infraUsage.js';

/**
 * LO QUE SE PAGA TODOS LOS MESES, haya o no un cliente más.
 *
 * ── Por qué esto faltaba ─────────────────────────────────────────────────
 * El analizador decía «servidores ₡0, están en plan gratuito» y daba margen
 * del 100% en los planes sin facturación electrónica. Dos cosas estaban mal:
 *
 *  1. VERCEL. El plan Hobby es gratis pero NO permite uso comercial. Un SaaS
 *     que se cobra corriendo ahí está fuera de los términos, así que el costo
 *     honesto es el de Pro. Contarlo como cero no es un ahorro: es una cuenta
 *     que todavía no llegó.
 *  2. SUPABASE sí es cero hoy —medido: 13% de la base, caben unos trescientos
 *     negocios más—, pero conviene decir CUÁNTO falta para que deje de serlo,
 *     no solo que hoy no se paga.
 *
 * Los fijos no se reparten entre los clientes: el costo de un cliente MÁS es
 * su costo variable. Los fijos van aparte, con cuántos clientes hacen falta
 * para cubrirlos, que es la pregunta de verdad.
 */

export interface CostosFijos {
  /** Colones por dólar, y de dónde salió. */
  tipo_cambio: number | null;
  tipo_cambio_fuente: string;
  conceptos: Array<{ concepto: string; usd: number; nota: string }>;
  total_usd: number;
  total_crc: number | null;
}

/**
 * El tipo de cambio, buscándolo donde de verdad hay uno.
 *
 * Primero el guardado; si no hay —y hoy no hay, porque nunca llegó a
 * persistirse—, el de la última factura cobrada en dólares. Es un dato real
 * del propio negocio, no un número inventado, y se dice de dónde salió para
 * que se pueda juzgar si sirve.
 */
export async function tipoDeCambio(): Promise<{ valor: number | null; fuente: string }> {
  const g = await leerGlobal<any>('exchange-rate');
  if (Number(g?.venta) > 0) return { valor: Number(g.venta), fuente: 'tipo de cambio del día (BCCR)' };
  try {
    const { data } = await db.from('invoices')
      .select('exchange_rate, issued_at').neq('currency', 'CRC')
      .not('exchange_rate', 'is', null)
      .order('issued_at', { ascending: false }).limit(1).maybeSingle();
    const v = Number((data as any)?.exchange_rate ?? 0);
    if (v > 0) {
      return { valor: v, fuente: `el de tu última factura en dólares (${String((data as any).issued_at).slice(0, 10)})` };
    }
  } catch { /* sigue sin tipo de cambio */ }
  return { valor: null, fuente: 'no hay ninguno guardado' };
}

export async function costosFijos(): Promise<CostosFijos> {
  const [cFE, infra, tc] = await Promise.all([costoFE(), medirInfraestructura(), tipoDeCambio()]);

  const MB = 1048576;
  const baseMb = (infra.supabase.base_bytes.valor ?? 0) / MB;
  const LIMITE_MB = 500;

  /**
   * LO QUE SE PAGA, no lo que se calcularía.
   *
   * Antes esto deducía el costo de Supabase del consumo medido: «cabe en el
   * plan gratuito, entonces cuesta cero». Estaba mal, y de una forma que vale
   * dejar escrita: el consumo dice qué plan HARÍA FALTA, no cuál se está
   * pagando. Son dos cosas distintas y la que importa para la cuenta es la
   * segunda — un plan contratado se paga aunque sobre capacidad.
   *
   * Por eso los montos se leen de la configuración y se pueden cambiar: son
   * datos de las suscripciones de quien usa esto, no algo que el sistema
   * pueda adivinar. La medición queda como NOTA, que sigue siendo útil para
   * saber si el plan contratado le queda grande.
   */
  const g = (await leerGlobal<any>('costos-fijos')) ?? {};
  const vercelUsd = Number(g.vercel_usd ?? 20);
  const supabaseUsd = Number(g.supabase_usd ?? 25);
  const holgura = baseMb <= LIMITE_MB
    ? `usás ${baseMb.toFixed(0)} MB, que cabrían en el plan gratuito de ${LIMITE_MB} MB`
    : `usás ${baseMb.toFixed(0)} MB; el plan gratuito llega a ${LIMITE_MB} MB`;

  const conceptos = [
    {
      concepto: 'Facturación electrónica',
      usd: cFE.mensual_usd,
      nota: `${cFE.incluidos} documentos incluidos; ₡${cFE.extra_crc} cada uno de más`,
    },
    {
      concepto: 'Vercel (Pro)',
      usd: vercelUsd,
      nota: 'El plan Hobby no permite uso comercial, así que Pro no es opcional',
    },
    {
      concepto: 'Supabase (Pro)',
      usd: supabaseUsd,
      // La holgura se dice, pero sin recomendar bajar de plan: el gratuito
      // pausa los proyectos inactivos y recorta el egreso, y para algo que
      // factura todos los días eso no es un ahorro.
      nota: `${holgura}. El gratuito pausa proyectos inactivos y limita el egreso`,
    },
  ].filter(x => x.usd > 0);

  const totalUsd = conceptos.reduce((s, x) => s + x.usd, 0);
  return {
    tipo_cambio: tc.valor,
    tipo_cambio_fuente: tc.fuente,
    conceptos,
    total_usd: totalUsd,
    total_crc: tc.valor ? Math.round(totalUsd * tc.valor) : null,
  };
}
