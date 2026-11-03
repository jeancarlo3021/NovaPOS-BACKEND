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

/**
 * Corta una promesa que se pasó de su plazo.
 *
 * El presupuesto por tarea era una SUGERENCIA: se le pasaba el número y se
 * confiaba en que lo respetara. Una tarea que se cuelga —un buzón que no
 * contesta, una consulta trabada— lo ignoraba y se llevaba puesto el trabajo
 * entero, que es exactamente lo que el presupuesto venía a evitar.
 *
 * Esto lo vuelve un límite de verdad. La tarea cortada sigue corriendo por su
 * cuenta hasta que termine o muera con la función; lo que importa es que el
 * trabajo pueda seguir y contestar a tiempo.
 */
export function conTope<T>(promesa: Promise<T>, ms: number, nombre: string): Promise<T> {
  let reloj: any;
  return Promise.race([
    promesa.finally(() => clearTimeout(reloj)),
    new Promise<T>((_, rechazar) => {
      reloj = setTimeout(() => rechazar(new Error(`«${nombre}» se pasó de ${Math.round(ms / 1000)} s y se cortó`)), ms);
    }),
  ]);
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
         alcance a salir aunque la tarea use todo lo que le dieron. Y el plazo
         se IMPONE: pasárselo como número no alcanza, porque la tarea que se
         cuelga es justo la que no lo mira. */
      const dado = Math.max(t.minimoMs, queda - 1_000);
      r.resultados[t.nombre] = await conTope(t.correr(dado), dado + 1_500, t.nombre);
    } catch (e: any) {
      r.fallidas.push({ nombre: t.nombre, error: String(e?.message ?? e).slice(0, 200) });
    }
  }

  r.tardo_ms = ahora() - t0;
  return r;
}
