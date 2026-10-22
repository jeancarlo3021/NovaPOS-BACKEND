import { db } from '../db/client.js';

/**
 * KITS DENTRO DE KITS.
 *
 * Un kit se vende como un producto, pero el inventario baja por lo que lleva
 * adentro. Hasta ahora un componente tenía que ser un producto suelto: meter un
 * kit dentro de otro estaba prohibido a propósito, porque el descuento en
 * cadena no existía y el stock habría quedado mintiendo.
 *
 * Acá vive esa cadena. Todo lo que necesita saber el resto del sistema —cuánto
 * cuesta, cuántos se pueden armar, qué se descuenta al vender— sale de UNA
 * operación: bajar hasta las HOJAS, los productos de verdad que mueven stock.
 *
 * Dos recaudos que no son opcionales:
 *  - Un ciclo (A lleva B, B lleva A) colgaría el servidor en un bucle infinito.
 *  - Una cadena demasiado profunda es casi siempre un error de carga, no un
 *    producto real.
 */

/** Cuántos niveles de kit dentro de kit se admiten. */
export const PROFUNDIDAD_MAX = 6;

export interface Composicion {
  /** kit_id → sus componentes DIRECTOS. */
  directos: Map<string, Array<{ component_id: string; quantity: number }>>;
  /** Qué productos son kits. */
  esKit: Set<string>;
}

/**
 * La composición de TODOS los kits del negocio, de dos consultas.
 *
 * Se trae entera a propósito: expandir un kit puede tocar cualquier otro, y
 * hacerlo con una consulta por nivel convierte una venta en una cascada de
 * viajes a la base justo cuando el cliente está esperando el tiquete.
 */
export async function cargarComposicion(tenantId: string): Promise<Composicion> {
  const directos = new Map<string, Array<{ component_id: string; quantity: number }>>();
  const esKit = new Set<string>();

  const { data: kits, error: kErr } = await db.from('products')
    .select('id').eq('tenant_id', tenantId).eq('is_kit', true);
  if (kErr && !/is_kit/i.test(kErr.message)) throw new Error(kErr.message);
  for (const k of (kits ?? []) as any[]) esKit.add(String(k.id));

  const { data: filas, error } = await db.from('product_kit_items')
    .select('kit_id, component_id, quantity').eq('tenant_id', tenantId);
  if (error && !/product_kit_items/i.test(error.message)) throw new Error(error.message);
  for (const f of (filas ?? []) as any[]) {
    const lista = directos.get(String(f.kit_id)) ?? [];
    lista.push({ component_id: String(f.component_id), quantity: Number(f.quantity) || 0 });
    directos.set(String(f.kit_id), lista);
  }
  return { directos, esKit };
}

/**
 * Baja un kit hasta sus HOJAS: cuánto de cada producto real hace falta.
 *
 * Un producto que no es kit se devuelve tal cual —así quien llama no tiene que
 * preguntar primero si lo es—. Las cantidades se multiplican por la cadena: dos
 * «Combo familiar» que llevan tres «Combo chico» de dos refrescos cada uno son
 * doce refrescos, y ese es el número que tiene que bajar del inventario.
 *
 * Si encuentra un ciclo deja de bajar por esa rama en vez de reventar: el
 * inventario quedará corto por esa rama, que es mucho menos grave que un
 * servidor trabado, y la validación de más abajo impide que se guarde.
 */
export function expandir(
  productoId: string,
  cantidad: number,
  comp: Composicion,
  visitados: Set<string> = new Set(),
  profundidad = 0,
): Map<string, number> {
  const hojas = new Map<string, number>();
  const id = String(productoId);
  const partes = comp.directos.get(id);

  const esHoja = !comp.esKit.has(id) || !partes?.length
    || profundidad >= PROFUNDIDAD_MAX || visitados.has(id);
  if (esHoja) {
    hojas.set(id, (hojas.get(id) ?? 0) + cantidad);
    return hojas;
  }

  const marcados = new Set(visitados).add(id);
  for (const parte of partes!) {
    const sub = expandir(parte.component_id, cantidad * parte.quantity, comp, marcados, profundidad + 1);
    for (const [hoja, qty] of sub) hojas.set(hoja, (hojas.get(hoja) ?? 0) + qty);
  }
  return hojas;
}

/**
 * ¿Meter estos componentes en este kit crearía un ciclo?
 *
 * Devuelve el camino culpable («Combo A → Combo B → Combo A») para poder
 * decírselo a quien lo está armando, en vez de un «no se puede» a secas.
 * Se evalúa contra la composición que QUEDARÍA, no la guardada: si no, el kit
 * se guardaría y el ciclo se descubriría al vender.
 */
export function buscarCiclo(
  kitId: string,
  componentes: Array<{ component_id: string }>,
  comp: Composicion,
): string[] | null {
  const directos = new Map(comp.directos);
  directos.set(String(kitId), componentes.map(c => ({ component_id: String(c.component_id), quantity: 1 })));
  const futura: Composicion = { directos, esKit: new Set(comp.esKit).add(String(kitId)) };

  const camino: string[] = [];
  const enCamino = new Set<string>();

  const bajar = (id: string): string[] | null => {
    if (enCamino.has(id)) return [...camino.slice(camino.indexOf(id)), id];
    if (!futura.esKit.has(id)) return null;
    camino.push(id); enCamino.add(id);
    for (const parte of futura.directos.get(id) ?? []) {
      const encontrado = bajar(String(parte.component_id));
      if (encontrado) return encontrado;
    }
    camino.pop(); enCamino.delete(id);
    return null;
  };
  return bajar(String(kitId));
}

/** Qué tan hondo baja la cadena de un kit (1 = solo productos sueltos). */
export function profundidadDe(kitId: string, comp: Composicion, visitados = new Set<string>()): number {
  const id = String(kitId);
  if (!comp.esKit.has(id) || visitados.has(id)) return 0;
  const partes = comp.directos.get(id);
  if (!partes?.length) return 0;
  const marcados = new Set(visitados).add(id);
  return 1 + Math.max(0, ...partes.map(p => profundidadDe(p.component_id, comp, marcados)));
}

/** Cambio de un componente por otro, decidido en el momento de la venta. */
export interface Sustitucion { from: string; to: string }

/**
 * Expande un kit APLICANDO los cambios que se hicieron al venderlo.
 *
 * El combo dice «galleta de chocolate», no hay, y el cliente acepta la de
 * vainilla. La composición del kit NO se toca —mañana vuelve a haber— pero el
 * inventario tiene que bajar lo que realmente salió de la bodega: la vainilla.
 *
 * El cambio se aplica a la HOJA, después de bajar toda la cadena, para que
 * valga igual si el producto estaba en el kit principal o tres niveles más
 * abajo dentro de un sub-kit.
 */
export function expandirConCambios(
  productoId: string,
  cantidad: number,
  comp: Composicion,
  cambios: Sustitucion[] = [],
): Map<string, number> {
  const hojas = expandir(productoId, cantidad, comp);
  if (!cambios.length) return hojas;

  const porOrigen = new Map(cambios
    .filter(c => c?.from && c?.to && String(c.from) !== String(c.to))
    .map(c => [String(c.from), String(c.to)]));
  if (!porOrigen.size) return hojas;

  const final = new Map<string, number>();
  for (const [hoja, qty] of hojas) {
    // Una sola salto: si el reemplazo fuera a su vez reemplazado, encadenar
    // sería adivinar una intención que nadie expresó.
    const destino = porOrigen.get(hoja) ?? hoja;
    final.set(destino, (final.get(destino) ?? 0) + qty);
  }
  return final;
}
