import { db } from '../db/client.js';

/**
 * Funciones del plan de un negocio, del lado del SERVIDOR.
 *
 * Hasta ahora el plan solo escondía botones en la pantalla. Para lo que hace
 * este módulo eso no alcanza: el consumo de inventario y el costo congelado
 * ocurren DENTRO de la venta, así que quien decide si corren tiene que ser el
 * servidor. Un cliente viejo, una app sin actualizar o una llamada directa a la
 * API no deben empezar a descontar ingredientes porque sí.
 *
 * El plan vive en `subscription_plans.features` (JSON) y se llega por la
 * suscripción del negocio.
 */

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; features: Record<string, any> }>();

/** Funciones del plan del negocio. Devuelve `{}` si no se pudo determinar. */
export async function tenantFeatures(tenantId: string): Promise<Record<string, any>> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.features;

  let features: Record<string, any> = {};
  try {
    const { data: sub } = await db.from('subscriptions')
      .select('plan_id').eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if ((sub as any)?.plan_id) {
      const { data: plan } = await db.from('subscription_plans')
        .select('features').eq('id', (sub as any).plan_id).maybeSingle();
      const f = (plan as any)?.features;
      if (f && typeof f === 'object') features = f;
    }
  } catch (e: any) {
    console.warn('[plan] no se pudieron leer las funciones:', e?.message);
  }

  cache.set(tenantId, { at: Date.now(), features });
  return features;
}

/**
 * ¿El negocio tiene ESTA función activa?
 *
 * Se exige `=== true`: a diferencia de otras banderas del sistema, las de este
 * módulo cambian lo que pasa con el inventario y la contabilidad, así que
 * «no configurado» tiene que significar APAGADO. Prender solo el descuento de
 * ingredientes por accidente le desordena el stock a un negocio entero.
 */
export async function hasFeature(tenantId: string, feature: string): Promise<boolean> {
  const f = await tenantFeatures(tenantId);
  return (f as any)?.[feature] === true;
}

/** Limpia el caché (al cambiar el plan desde el panel admin). */
export function clearPlanCache(): void {
  cache.clear();
}
