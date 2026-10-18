import { db } from '../db/client.js';

/**
 * QUÉ LE FALTA USAR A CADA NEGOCIO.
 *
 * El problema real: un negocio paga un plan con doce módulos y usa dos. No
 * porque no le sirvan, sino porque no sabe que están. Después se va diciendo
 * que «el sistema no hace mucho».
 *
 * ── Por qué esto se MIDE y no se adivina ──────────────────────────────────
 * Cada recomendación sale de comparar dos cosas que están en la base: lo que
 * el plan del negocio tiene activado, y si ese módulo tiene datos. «Tenés
 * inventario en tu plan y cero productos cargados» es un hecho; «aprovechá
 * más el inventario» es relleno, y el cliente lo nota.
 *
 * Nada de esto pasa por un modelo de lenguaje. El modelo —cuando se encienda—
 * sirve para REDACTAR el anuncio, no para inventar qué usa un negocio.
 */

export interface Recomendacion {
  modulo: string;
  /** Lo que se le diría al cliente, ya redactado. */
  texto: string;
  /** El hecho que lo respalda, para poder verificarlo. */
  evidencia: string;
}

/** Cuenta filas de una tabla para un negocio. -1 si la tabla no existe. */
async function contar(tabla: string, tenantId: string, filtro?: (q: any) => any): Promise<number> {
  try {
    let q = db.from(tabla).select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId);
    if (filtro) q = filtro(q);
    const { count, error } = await q;
    if (error) return -1;
    return Number(count ?? 0);
  } catch { return -1; }
}

/**
 * Los módulos que se revisan.
 *
 * Cada uno dice: en qué bandera del plan vive, qué tabla delata que se está
 * usando, y qué decirle al cliente si la tabla está vacía. Agregar un módulo
 * nuevo es agregar una línea acá, no tocar la lógica.
 */
const MODULOS: Array<{
  flag: string; nombre: string; tabla: string;
  texto: (n: number) => string;
}> = [
  { flag: 'inventory', nombre: 'Inventario', tabla: 'products',
    texto: () => 'Tenés el inventario incluido en tu plan y todavía no hay productos cargados. '
      + 'Con los productos adentro, el sistema te avisa qué se está acabando antes de que falte.' },
  { flag: 'customers', nombre: 'Clientes', tabla: 'customers',
    texto: () => 'No tenés clientes registrados. Cargándolos podés ver quién te compra más y '
      + 'mandarles el comprobante por WhatsApp sin volver a escribir los datos.' },
  { flag: 'promotions', nombre: 'Promociones', tabla: 'promotions',
    texto: () => 'Las promociones están incluidas en tu plan y no hay ninguna creada. '
      + 'Un 2×1 o un descuento por cantidad se configuran una vez y la caja los aplica sola.' },
  { flag: 'expenses', nombre: 'Gastos', tabla: 'expenses',
    texto: () => 'No estás registrando gastos. Sin ellos, los reportes muestran lo que entra '
      + 'pero no lo que queda, que es el número que de verdad importa.' },
  { flag: 'purchases', nombre: 'Compras', tabla: 'purchases',
    texto: () => 'No hay compras registradas. Al cargarlas, el inventario se actualiza solo y '
      + 'el costo de cada producto queda guardado para saber cuánto deja cada venta.' },
  { flag: 'accounts_receivable', nombre: 'Cuentas por cobrar', tabla: 'accounts_receivable',
    texto: () => 'Tenés cuentas por cobrar en el plan y no hay ninguna registrada. '
      + 'Si vendés a crédito, el sistema te lleva la cuenta y avisa cuando vence.' },
  { flag: 'digital_menu', nombre: 'Menú digital', tabla: 'digital_menus',
    texto: () => 'El menú digital con código QR está en tu plan y no lo has armado. '
      + 'Es una carta que el cliente abre desde su teléfono, sin imprimir nada.' },
  { flag: 'recipes', nombre: 'Recetas', tabla: 'recipes',
    texto: () => 'Las recetas están incluidas y no hay ninguna. Con ellas sabés cuánto te cuesta '
      + 'cada plato de verdad, con los ingredientes al precio de hoy.' },
];

export async function recomendacionesPara(tenantId: string, features: any): Promise<Recomendacion[]> {
  const f = features ?? {};
  const salida: Recomendacion[] = [];

  /**
   * Las cuentas van EN PARALELO.
   *
   * Una por una, revisar cincuenta negocios tardaba 87 segundos: son nueve
   * consultas por negocio, cada una esperando a la anterior sin ningún
   * motivo. Son independientes entre sí, así que salen todas juntas.
   */
  const aRevisar = MODULOS.filter(m => f[m.flag] === true);
  const cuentas = await Promise.all(aRevisar.map(m => contar(m.tabla, tenantId)));

  aRevisar.forEach((m, i) => {
    const n = cuentas[i];
    if (n !== 0) return;                          // ya lo usa (o la tabla no existe acá)
    salida.push({
      modulo: m.nombre,
      texto: m.texto(n),
      evidencia: `El plan tiene «${m.nombre}» activo y la tabla ${m.tabla} está vacía para este negocio.`,
    });
  });

  /**
   * Facturación electrónica configurada pero sin usar.
   *
   * Es el caso más caro de todos: el negocio pagó por la FE, hizo el trámite
   * y no está emitiendo. O no supo cómo seguir, o algo le falló y no avisó.
   */
  if (f.electronic_invoice === true) {
    const emitidas = await contar('invoices', tenantId, (q: any) => q.not('clave', 'is', null));
    if (emitidas === 0) {
      salida.push({
        modulo: 'Facturación electrónica',
        texto: 'Tenés la facturación electrónica incluida y todavía no has emitido ninguna. '
          + 'Si algo se trabó en la configuración, lo vemos juntos: ya está pago.',
        evidencia: 'El plan tiene «electronic_invoice» y no hay facturas con clave de Hacienda.',
      });
    }
  }

  return salida;
}
