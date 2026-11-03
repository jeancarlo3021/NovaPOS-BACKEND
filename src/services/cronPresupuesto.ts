/**
 * EL PRESUPUESTO DE TIEMPO DE UN TRABAJO PROGRAMADO.
 *
 * El cron de correos terminó haciendo cinco cosas: leer el buzón, limpiar
 * demos, avisar cobros, respaldar y despachar anuncios. Cada una se colgó de
 * ahí por una buena razón —es el único trabajo que SÍ está configurado— y
 * cada una llegó con su propio plazo, puesto sin mirar a las demás:
 *
 *   correos 22 s + respaldos 18 s + anuncios 6 s = 46 s, más demos y cobros
 *
 * El cron externo corta a los 30. O sea que el trabajo no se estaba poniendo
 * lento: nunca podía terminar. Y al cortarse por tiempo, lo último de la fila
 * —los anuncios— no corría NUNCA.
 *
 * Acá se reparte un presupuesto ÚNICO:
 *  · cada tarea recibe lo que queda, no un número fijo escrito hace meses;
 *  · la que no entra se SALTA y se dice en la respuesta, en vez de hacer
 *    reventar el trabajo entero;
 *  · el orden ROTA, así la última de la fila también tiene sus turnos de ser
 *    la primera. Sin eso, el que queda al final con un presupuesto apretado
 *    no corre jamás y nadie se entera.
 */

export interface Tarea {
  nombre: string;
  /** Mínimo con el que vale la pena arrancarla. Menos que eso, se salta. */
  minimoMs: number;
  /** Recibe lo que queda del presupuesto. */
  correr: (presupuestoMs: number) => Promise<any>;
}

export interface ResultadoTareas {
  /** Lo que devolvió cada tarea que corrió. */
  resultados: Record<string, any>;
  /** Las que no entraron en el tiempo, con el motivo. */
  saltadas: Array<{ nombre: string; falto_ms: number }>;
  /** Las que fallaron. Una tarea caída no tumba a las demás. */
  fallidas: Array<{ nombre: string; error: string }>;
  presupuesto_ms: number;
  tardo_ms: number;
}

/**
 * Corre las tareas repartiendo un presupuesto, rotando el orden.
 *
 * `turno` decide desde cuál empieza: por omisión sale del reloj, en tramos de
 * quince minutos, que es cada cuánto corre el trabajo. Se puede pasar a mano
 * para poder probarlo.
 */
export async function correrConPresupuesto(
  tareas: Tarea[],
  opciones: { presupuestoMs: number; turno?: number; ahora?: () => number } = { presupuestoMs: 25_000 },
): Promise<ResultadoTareas> {
  const ahora = opciones.ahora ?? Date.now;
  const t0 = ahora();
  const presupuesto = Math.max(1_000, opciones.presupuestoMs);
  const restante = () => presupuesto - (ahora() - t0);

  const giro = opciones.turno ?? Math.floor(t0 / 900_000);
  const orden = tareas.length > 0
    ? [...tareas.slice(giro % tareas.length), ...tareas.slice(0, giro % tareas.length)]
    : [];

  const r: ResultadoTareas = {
    resultados: {}, saltadas: [], fallidas: [],
    presupuesto_ms: presupuesto, tardo_ms: 0,
  };

  for (const t of orden) {
    const queda = restante();
    if (queda < t.minimoMs) {
      r.saltadas.push({ nombre: t.nombre, falto_ms: t.minimoMs - queda });
      continue;
    }
    try {
      /* Se le da lo que queda MENOS un resguardo, para que la respuesta
         alcance a salir aunque la tarea use todo lo que le dieron. */
      r.resultados[t.nombre] = await t.correr(Math.max(t.minimoMs, queda - 1_000));
    } catch (e: any) {
      r.fallidas.push({ nombre: t.nombre, error: String(e?.message ?? e).slice(0, 200) });
    }
  }

  r.tardo_ms = ahora() - t0;
  return r;
}
