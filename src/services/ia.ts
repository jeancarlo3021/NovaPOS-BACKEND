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
 * QUIÉN PUEDE GASTAR.
 *
 * Encender la IA cuesta plata por consulta, así que no alcanza con que el
 * servidor la tenga encendida: cada llamada tiene que decir que está
 * autorizada. Sin este permiso explícito, `pedirAlModelo` se comporta como en
 * modo demostración y devuelve null, que es lo que ya saben manejar todos los
 * que lo llaman.
 *
 * Hoy el único lugar autorizado es la carga masiva de productos hecha por el
 * super-administrador. Un cajero clasificando un producto suelto, o cualquier
 * otro negocio, siguen resolviendo con el buscador local y sin costo.
 */
export interface PermisoIA {
  /** Para qué se está pidiendo. Sirve para el registro y para auditar el gasto. */
  motivo: string;
  /** Lo decide la ruta: dueño de la cuenta + pantalla habilitada. */
  autorizado: boolean;
}

/** Cliente del SDK, construido una sola vez y solo si hace falta. */
let cliente: any = null;
async function clienteIA() {
  if (cliente) return cliente;
  /*
   * Se usa la exportación CON NOMBRE, no la `default`.
   *
   * El paquete es CommonJS y lo cargamos con `import()` dinámico: según la
   * configuración de módulos, TypeScript tipa `.default` como el módulo
   * entero y no como la clase. Compilaba acá y reventaba en Vercel con
   * «This expression is not constructable». `Anthropic` sale exportado con
   * nombre desde el mismo archivo, y así se construye igual en los dos lados.
   */
  const mod: any = await import('@anthropic-ai/sdk');
  // Según cómo compile cada lado, la clase llega en `Anthropic`, en
  // `default.Anthropic` o directamente en `default`. Se prueban las tres en
  // vez de atar el despliegue a una configuración de módulos concreta.
  const Anthropic = mod.Anthropic ?? mod.default?.Anthropic ?? mod.default;
  cliente = new Anthropic();   // lee ANTHROPIC_API_KEY del entorno
  return cliente;
}

/**
 * Punto único por donde pasa una llamada al modelo.
 *
 * Está centralizado a propósito: encender o apagar la IA es tocar ESTE
 * archivo y nada más. Si cada función llamara al modelo por su cuenta,
 * encenderla sería tocar cinco lugares y apagarla, otros cinco.
 *
 * Nunca lanza: una falla del modelo no puede tumbar una importación de
 * quinientos productos. Devuelve null y quien llama sigue con lo que tenía,
 * que es exactamente lo que pasa en modo demostración.
 */
export async function pedirAlModelo(opts: {
  sistema: string;
  mensaje: string;
  maxTokens?: number;
  permiso?: PermisoIA;
}): Promise<string | null> {
  if (modoIA() === 'demo') return null;
  if (!opts.permiso?.autorizado) return null;

  try {
    const anthropic = await clienteIA();
    const r = await anthropic.messages.create({
      model: MODELO_IA,
      max_tokens: opts.maxTokens ?? 256,
      // Esfuerzo bajo: esto es elegir entre tres opciones dadas, no razonar un
      // problema. Es la diferencia entre centavos y dólares al mes.
      output_config: { effort: 'low' },
      system: opts.sistema,
      messages: [{ role: 'user', content: opts.mensaje }],
    });
    const texto = (r.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
      .trim();
    return texto || null;
  } catch (e: any) {
    // Se registra con el motivo para poder ver DESDE DÓNDE se gastó o falló.
    console.warn(`[ia] falló la consulta al modelo (${opts.permiso?.motivo ?? 'sin motivo'}):`, e?.message);
    return null;
  }
}
