/**
 * ASISTENTE DE IA — hoy en MODO DEMOSTRACIÓN.
 *
 * Las funciones de IA están armadas de punta a punta —pantallas, endpoints,
 * datos— pero **no llaman a ningún modelo**: las respuestas se arman acá con
 * los datos del propio negocio. Así se puede ver, probar y mostrar a un cliente
 * sin gastar un centavo, y el día que se decida encenderla se cambia una
 * variable de entorno y lo mismo pasa a resolverlo el modelo.
 *
 * ── Por qué el modo demostración es el valor POR OMISIÓN ──────────────────
 * Incluso con la llave configurada, esto sigue en demostración hasta que
 * alguien ponga `IA_MODO=real` a propósito. Una llave olvidada en el entorno
 * no puede convertirse sola en una factura a fin de mes.
 *
 * Cuando se encienda:
 *   IA_MODO=real
 *   ANTHROPIC_API_KEY=...        (la llave vive SOLO acá, nunca en el navegador)
 *   IA_MODELO=claude-haiku-5-5   (opcional; por defecto, el más barato)
 *
 * La llave nunca viaja al frontend. Si se pusiera ahí, cualquiera que abra las
 * herramientas del navegador se la lleva y las llamadas las paga el negocio.
 */

export type ModoIA = 'demo' | 'real';

/** Modo efectivo. Demostración salvo que se pida lo contrario EXPLÍCITAMENTE. */
export function modoIA(): ModoIA {
  const pedido = String(process.env.IA_MODO ?? '').trim().toLowerCase();
  if (pedido !== 'real') return 'demo';
  // Pedir «real» sin llave es un error de configuración, no una razón para
  // fallar en silencio: se avisa y se sigue en demostración.
  if (!String(process.env.ANTHROPIC_API_KEY ?? '').trim()) {
    console.warn('[ia] IA_MODO=real pero falta ANTHROPIC_API_KEY: sigue en modo demostración');
    return 'demo';
  }
  return 'real';
}

/** Modelo a usar cuando se encienda. El más barato alcanza para estas tareas. */
export const MODELO_IA = String(process.env.IA_MODELO ?? 'claude-haiku-5-5').trim();

/**
 * El aviso que acompaña a TODA respuesta en modo demostración.
 *
 * Va en la respuesta y la pantalla lo muestra: alguien tiene que poder
 * distinguir «esto lo armó el sistema con reglas» de «esto lo pensó un
 * modelo», sobre todo antes de mostrárselo a un cliente.
 */
export const AVISO_DEMO =
  'Modo demostración: esta respuesta la armó el sistema con los datos del negocio, sin usar inteligencia artificial.';

export interface RespuestaIA<T> {
  modo: ModoIA;
  aviso?: string;
  datos: T;
}

export function respuesta<T>(datos: T): RespuestaIA<T> {
  const modo = modoIA();
  return { modo, ...(modo === 'demo' ? { aviso: AVISO_DEMO } : {}), datos };
}

/**
 * Punto único por donde pasaría una llamada al modelo.
 *
 * Hoy devuelve null siempre: el modo demostración ni siquiera construye el
 * cliente. Está acá para que encender la IA sea cambiar ESTE archivo y nada
 * más —si cada función llamara al modelo por su cuenta, encenderla sería tocar
 * cinco lugares y apagarla, otros cinco—.
 */
export async function pedirAlModelo(_opts: {
  sistema: string;
  mensaje: string;
  maxTokens?: number;
}): Promise<string | null> {
  if (modoIA() === 'demo') return null;
  throw new Error(
    'La IA está en modo real pero todavía no está conectada. '
    + 'Instalá @anthropic-ai/sdk y completá `pedirAlModelo` en services/ia.ts.',
  );
}
