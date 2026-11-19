import { db } from '../db/client.js';

/**
 * Inserta movimientos de inventario tolerando que la migración 145 no haya
 * corrido todavía.
 *
 * `source` y `batch_id` son de esa migración. PostgREST falla el insert ENTERO
 * cuando una columna no existe, así que sin este reintento el ajuste, la merma
 * o la recepción de una compra no se registrarían: perder el vínculo con la
 * compra o con el lote es molesto, perder el movimiento sería un descuadre de
 * inventario.
 */
export async function insertarAjustes(
  filas: Record<string, any>[],
): Promise<{ error: { message: string } | null; sinColumnasNuevas: boolean }> {
  if (filas.length === 0) return { error: null, sinColumnasNuevas: false };

  let r: any = await db.from('stock_adjustments').insert(filas);
  if (r.error && /source|batch_id/.test(r.error.message ?? '')) {
    const limpias = filas.map(({ source: _s, batch_id: _b, ...resto }) => resto);
    r = await db.from('stock_adjustments').insert(limpias);
    return { error: r.error ?? null, sinColumnasNuevas: true };
  }
  return { error: r.error ?? null, sinColumnasNuevas: false };
}
