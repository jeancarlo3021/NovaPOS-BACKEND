import { db } from '../db/client.js';
import { leerGlobal } from './globalSettings.js';

/**
 * LO QUE CUESTA LA FACTURACIÓN ELECTRÓNICA.
 *
 * Es el costo variable real del negocio, y hasta ahora el sistema no lo
 * conocía: los análisis de planes daban «el margen es prácticamente todo»
 * porque solo miraban Supabase y Vercel, que están en plan gratuito. El
 * proveedor de FE no: se paga todos los meses y, pasada la bolsa, cada
 * documento tiene precio.
 *
 * ── Por qué esto cambia las conclusiones ─────────────────────────────────
 * Medido hoy: entre 754 y 911 documentos por mes contra una bolsa de 1000.
 * Están al borde. Eso significa que el costo del PRÓXIMO cliente no es cero
 * —como decía el análisis anterior— sino ₡4,6 por cada documento que emita,
 * porque ya va a caer del lado de afuera de la bolsa. Un cliente que factura
 * doscientas veces al mes cuesta ₡920 mensuales en documentos extra.
 */

export interface CostoFE {
  /** Lo que se paga fijo al mes, en dólares. */
  mensual_usd: number;
  /** Documentos incluidos en esa mensualidad. */
  incluidos: number;
  /** Lo que cuesta cada documento por encima, en colones. */
  extra_crc: number;
}

/** Lo que se paga hoy. Editable sin tocar código: el proveedor cambia precios. */
export const COSTO_FE_POR_OMISION: CostoFE = {
  mensual_usd: 56,
  incluidos: 1000,
  extra_crc: 4.6,
};

export async function costoFE(): Promise<CostoFE> {
  const g = await leerGlobal<Partial<CostoFE>>('costo-fe');
  return {
    mensual_usd: Number(g?.mensual_usd ?? COSTO_FE_POR_OMISION.mensual_usd),
    incluidos: Number(g?.incluidos ?? COSTO_FE_POR_OMISION.incluidos),
    extra_crc: Number(g?.extra_crc ?? COSTO_FE_POR_OMISION.extra_crc),
  };
}

/**
 * CUÁNTOS DOCUMENTOS ELECTRÓNICOS se emitieron, y quién los emitió.
 *
 * Cuenta facturas, notas de crédito y notas de débito: el proveedor las cobra
 * todas por igual, así que contar solo facturas subestimaría el consumo
 * —medido, las notas son cerca del 3%—.
 */
export async function documentosFE(dias = 30): Promise<{
  total: number;
  por_tenant: Map<string, number>;
  desglose: { facturas: number; notas_credito: number; notas_debito: number };
}> {
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
  const porTenant = new Map<string, number>();
  const contar = async (columna: string) => {
    let n = 0;
    for (let d = 0; ; d += 1000) {
      const { data, error } = await db.from('invoices')
        .select(`tenant_id, ${columna}`)
        .not(columna, 'is', null).gte('issued_at', desde)
        .order('id', { ascending: true }).range(d, d + 999);
      if (error) break;
      const filas = (data ?? []) as any[];
      for (const f of filas) {
        porTenant.set(f.tenant_id, (porTenant.get(f.tenant_id) ?? 0) + 1);
        n += 1;
      }
      if (filas.length < 1000) break;
    }
    return n;
  };
  const facturas = await contar('fe_clave');
  const notasCredito = await contar('fe_nc_clave');
  const notasDebito = await contar('fe_nd_clave');

  return {
    total: facturas + notasCredito + notasDebito,
    por_tenant: porTenant,
    desglose: { facturas, notas_credito: notasCredito, notas_debito: notasDebito },
  };
}

/**
 * EL COSTO MARGINAL DE UN DOCUMENTO MÁS.
 *
 * Cero mientras quede bolsa; `extra_crc` cuando ya no. Es la pregunta que
 * importa al pensar un plan nuevo: no «cuánto cuesta en total» sino «cuánto
 * cuesta el próximo cliente», y eso depende de dónde esté el contador hoy.
 */
export function costoDelProximoDocumento(usoActual: number, c: CostoFE): number {
  return usoActual >= c.incluidos ? c.extra_crc : 0;
}

/**
 * Lo que costarían N documentos más, partiendo del uso de hoy.
 *
 * Contempla el caso del medio: si quedan 90 de bolsa y el cliente emite 200,
 * se pagan 110. Redondear eso a «todo gratis» o «todo pago» da de menos o de
 * más justo en el tramo donde está el negocio ahora.
 */
export function costoDeAgregar(documentos: number, usoActual: number, c: CostoFE): number {
  const libres = Math.max(0, c.incluidos - usoActual);
  const pagos = Math.max(0, documentos - libres);
  return Math.round(pagos * c.extra_crc * 100) / 100;
}
