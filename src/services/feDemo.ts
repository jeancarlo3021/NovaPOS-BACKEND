import { db } from '../db/client.js';

/**
 * FACTURACIÓN ELECTRÓNICA EN UNA DEMO: comprobantes FICTICIOS, ilimitados.
 *
 * Una demo no tiene cédula, ni certificado, ni empresa dada de alta en el
 * proveedor —no puede tenerlos: no es un contribuyente—. Con eso, el POS
 * electrónico se moría en el primer clic con «La facturación electrónica no
 * está activada», que es justo la pantalla que hay que mostrar para vender el
 * sistema. El vendedor quedaba explicando por qué la función estrella no
 * arranca.
 *
 * Acá el comprobante se SIMULA: se crea la venta igual que siempre, avanza el
 * consecutivo igual que siempre y se guarda con una clave de 50 dígitos bien
 * formada, pero NO se le manda nada a Hacienda ni al proveedor. Se puede hacer
 * la cantidad que se quiera: una demo no consume bolsa porque no hay bolsa.
 *
 * Que sea reconocible importa tanto como que funcione:
 *   · la cédula del emisor dentro de la clave va en CEROS cuando la demo no
 *     tiene una configurada, así que la clave no colisiona con la de ningún
 *     contribuyente real ni se puede confundir con una válida;
 *   · queda marcada con `fe_environment = 'demo'`, que es lo que usan los
 *     procesos de fondo para no intentar consultarla, reenviarla ni cobrarla.
 *
 * NUNCA se activa por configuración: se activa porque el negocio es demo
 * (`tenants.is_demo`). Un negocio de verdad no puede caer acá por error.
 */

/** Marca de ambiente de los comprobantes simulados. */
export const AMBIENTE_DEMO = 'demo';

/**
 * CABYS de relleno para la demo.
 *
 * Hacienda exige un CABYS por línea, y en una demo los productos de prueba no
 * lo tienen: la emisión moría con «Estos productos no tienen código CABYS»,
 * que para el que está viendo la demostración es otra pared.
 *
 * Va en CEROS a propósito, igual que la cédula dentro de la clave: no es un
 * código real, no le enseña a nadie un número equivocado, y deja claro en el
 * documento que el comprobante es de mentira.
 */
export const CABYS_DEMO = '0000000000000';

/**
 * ¿Es un negocio de demostración?
 *
 * Se cachea un rato: esto se consulta en cada emisión y la respuesta no cambia
 * en la vida de un negocio (una demo se convierte en cliente borrándola y
 * creándolo de nuevo, no cambiando la bandera).
 */
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { demo: boolean; hasta: number }>();

export async function esTenantDemo(tenantId: string): Promise<boolean> {
  const k = String(tenantId ?? '');
  if (!k) return false;
  const hit = cache.get(k);
  if (hit && hit.hasta > Date.now()) return hit.demo;
  try {
    const { data } = await db.from('tenants').select('is_demo').eq('id', k).maybeSingle();
    const demo = (data as any)?.is_demo === true;
    cache.set(k, { demo, hasta: Date.now() + CACHE_MS });
    return demo;
  } catch {
    // Ante la duda, NO es demo: emitir de verdad es el comportamiento correcto
    // para un cliente, y simular el de un cliente real sería mucho peor.
    return false;
  }
}

const soloDigitos = (v: any) => String(v ?? '').replace(/\D/g, '');

/**
 * Clave de 50 dígitos con la estructura de Hacienda, para la demo.
 *
 * 506 (país) + ddmmaa + cédula(12) + consecutivo(20) + situación(1) + seguridad(8).
 * El consecutivo es el mismo que llevaría el comprobante real, para que lo que
 * se ve en pantalla y en el papel sea lo que vería el cliente.
 */
export function claveFicticia(opts: {
  cedula?: string | null;
  sucursal?: string | null;
  terminal?: string | null;
  tipoDoc: string;
  consecutivo: string;
}): string {
  const cr = new Date(Date.now() - 6 * 3_600_000);   // reloj de pared de Costa Rica
  const dd = String(cr.getUTCDate()).padStart(2, '0');
  const mm = String(cr.getUTCMonth() + 1).padStart(2, '0');
  const aa = String(cr.getUTCFullYear()).slice(-2);

  const cedula = soloDigitos(opts.cedula).slice(-12).padStart(12, '0');
  const suc = soloDigitos(opts.sucursal || '1').padStart(3, '0').slice(-3);
  const term = soloDigitos(opts.terminal || '1').padStart(5, '0').slice(-5);
  const tipo = soloDigitos(opts.tipoDoc).padStart(2, '0').slice(-2);
  const num = soloDigitos(opts.consecutivo).padStart(10, '0').slice(-10);
  const seguridad = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');

  return `506${dd}${mm}${aa}${cedula}${suc}${term}${tipo}${num}1${seguridad}`;
}

/** Consecutivo de Hacienda (20 díg) que va dentro de la clave. */
export function consecutivoDeClave(clave: string): string | null {
  const d = soloDigitos(clave);
  return d.length === 50 ? d.slice(21, 41) : null;
}

/**
 * Marca la venta como comprobante ficticio ACEPTADO y devuelve sus datos.
 *
 * Se guarda como «aceptado» a propósito: la demo tiene que verse como se ve el
 * sistema funcionando. Lo que la distingue es `fe_environment`, no un estado
 * raro que obligue a tratar las pantallas de forma especial.
 */
export async function marcarComprobanteDemo(
  tenantId: string, invoiceId: string,
  opts: { tipoDoc: string; consecutivo: string; cedula?: string | null; sucursal?: string | null; terminal?: string | null; documento?: any },
): Promise<{ clave: string; consecutivo: string | null }> {
  const clave = claveFicticia(opts);
  await db.from('invoices').update({
    fe_clave: clave,
    fe_consecutivo: null,          // no hay documento en el proveedor que consultar
    fe_status: 'accepted',
    fe_situacion: '1',
    fe_environment: AMBIENTE_DEMO,
    fe_error: null,
    fe_request: opts.documento ?? null,
    fe_response: { demo: true, nota: 'Comprobante simulado: no se envió a Hacienda' },
    updated_at: new Date().toISOString(),
  }).eq('id', invoiceId).eq('tenant_id', tenantId);
  return { clave, consecutivo: consecutivoDeClave(clave) };
}
