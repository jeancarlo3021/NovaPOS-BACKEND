import { db } from '../db/client.js';

/**
 * AJUSTES QUE NO SON DE NINGÚN NEGOCIO.
 *
 * El tipo de cambio del día, cuánto deja cada plan: cosas de la plataforma,
 * no de un comercio.
 *
 * Antes se guardaban en `settings` con un `tenant_id` de ceros, y nunca
 * funcionó: esa columna tiene clave foránea contra `tenants`, así que el
 * insert fallaba y el error quedaba atrapado en un `try/catch`. Medido contra
 * la base: cero filas de tipo de cambio guardadas en toda la vida del
 * sistema. El respaldo «si el BCCR está caído, usá el último conocido» no
 * tenía nunca un último conocido.
 */

/** Lee un ajuste global. `null` si no existe o si la tabla todavía no está. */
export async function leerGlobal<T = any>(type: string): Promise<T | null> {
  try {
    const { data, error } = await db.from('global_settings')
      .select('config').eq('type', type).maybeSingle();
    if (error) return null;
    return ((data as any)?.config ?? null) as T | null;
  } catch { return null; }
}

/**
 * Guarda un ajuste global. Devuelve si se pudo.
 *
 * Devuelve `false` en vez de tirar: quien lo llama suele estar haciendo otra
 * cosa más importante —servir el tipo de cambio, por ejemplo— y no debe
 * fallar porque el guardado no salió. Pero SÍ tiene que poder enterarse, que
 * es lo que faltaba antes.
 */
export async function guardarGlobal(type: string, config: any): Promise<boolean> {
  try {
    const { error } = await db.from('global_settings').upsert(
      { type, config, updated_at: new Date().toISOString() },
      { onConflict: 'type' },
    );
    if (error) {
      console.warn(`[global_settings] no se pudo guardar «${type}»: ${error.message}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn(`[global_settings] no se pudo guardar «${type}»: ${e?.message}`);
    return false;
  }
}
