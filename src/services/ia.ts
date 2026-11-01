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
 *   IA_PROVEEDOR=gemini|anthropic   (por defecto gemini si hay GEMINI_API_KEY)
 *   GEMINI_API_KEY=...   ·   ANTHROPIC_API_KEY=...
 *   IA_MODELO=...        (opcional; por defecto el más barato de cada uno)
 *
 * ── Por qué DOS proveedores ───────────────────────────────────────────────
 * Las tareas de acá son chicas y repetitivas —elegir un CAByS entre tres
 * candidatos, redactar dos líneas, contestar una pregunta sobre los datos del
 * negocio—. Para eso, un modelo «flash» cuesta una fracción y responde igual
 * de bien. El proveedor se elige por variable de entorno y el resto del
 * sistema no se entera: todo pasa por `pedirAlModelo`.
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
  if (!llaveDe(proveedorIA())) {
    console.warn(`[ia] IA_MODO=real pero falta la llave de ${proveedorIA()}: sigue en modo demostración`);
    return 'demo';
  }
  return 'real';
}

export type ProveedorIA = 'gemini' | 'anthropic';

/**
 * Qué proveedor contesta.
 *
 * Por omisión, el que TENGA LLAVE, prefiriendo Gemini: es el más barato para
 * estas tareas y es con el que está pensado el gasto. Poner `IA_PROVEEDOR`
 * manda sobre eso.
 */
export function proveedorIA(): ProveedorIA {
  const pedido = String(process.env.IA_PROVEEDOR ?? '').trim().toLowerCase();
  if (pedido === 'anthropic' || pedido === 'claude') return 'anthropic';
  if (pedido === 'gemini' || pedido === 'google') return 'gemini';
  if (String(process.env.GEMINI_API_KEY ?? '').trim()) return 'gemini';
  return 'anthropic';
}

function llaveDe(p: ProveedorIA): string {
  return String((p === 'gemini' ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY) ?? '').trim();
}

/** Modelo por omisión de cada proveedor: el más barato que alcanza. */
const MODELO_POR_DEFECTO: Record<ProveedorIA, string> = {
  gemini: 'gemini-2.5-flash',
  anthropic: 'claude-haiku-5-5',
};

/** Modelo a usar cuando se encienda. El más barato alcanza para estas tareas. */
export function modeloIA(): string {
  return String(process.env.IA_MODELO ?? '').trim() || MODELO_POR_DEFECTO[proveedorIA()];
}

/** Compatibilidad con lo que ya lo importaba por constante. */
export const MODELO_IA = modeloIA();

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

/**
 * CACHÉ DE RESPUESTAS — la llamada más barata es la que no se hace.
 *
 * Las preguntas se repiten muchísimo: «¿qué CAByS le pongo a una Coca-Cola de
 * 600 ml?» la van a hacer veinte negocios distintos, y el mismo negocio la
 * repite cada vez que importa su catálogo. Guardar la respuesta y devolverla
 * sin tocar el modelo es la diferencia entre centavos y dólares al mes.
 *
 * Dos niveles:
 *   · memoria del proceso — gratis e instantáneo, pero se pierde en cada
 *     despliegue y no se comparte entre instancias;
 *   · tabla `ia_cache` — sobrevive y la comparten todas las instancias.
 *
 * Si la tabla todavía no existe (migración sin correr), sigue funcionando solo
 * con la memoria: la caché es una optimización, no un requisito.
 */
const memoria = new Map<string, { texto: string; vence: number }>();
const MEMORIA_MAX = 500;

async function clave(partes: string[]): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(partes.join('\u0000')).digest('hex');
}

let tablaCacheViva = true;

async function leerCache(k: string): Promise<string | null> {
  const enMemoria = memoria.get(k);
  if (enMemoria && enMemoria.vence > Date.now()) return enMemoria.texto;
  if (enMemoria) memoria.delete(k);
  if (!tablaCacheViva) return null;
  try {
    const { db } = await import('../db/client.js');
    const { data, error } = await db.from('ia_cache')
      .select('respuesta, vence_el').eq('clave', k).maybeSingle();
    if (error) { if (/ia_cache/i.test(error.message)) tablaCacheViva = false; return null; }
    if (!data) return null;
    const vence = (data as any).vence_el ? new Date((data as any).vence_el).getTime() : Infinity;
    if (vence < Date.now()) return null;
    const texto = String((data as any).respuesta ?? '');
    if (texto) memoria.set(k, { texto, vence: Math.min(vence, Date.now() + 10 * 60_000) });
    // El contador de usos es lo que después deja ver CUÁNTO ahorró la caché.
    void db.from('ia_cache').update({ usos_extra: 1, ultimo_uso: new Date().toISOString() }).eq('clave', k);
    return texto || null;
  } catch { return null; }
}

async function guardarCache(k: string, texto: string, ttlMin: number, modelo: string): Promise<void> {
  memoria.set(k, { texto, vence: Date.now() + Math.min(ttlMin, 10) * 60_000 });
  if (memoria.size > MEMORIA_MAX) memoria.delete(memoria.keys().next().value as string);
  if (!tablaCacheViva) return;
  try {
    const { db } = await import('../db/client.js');
    const { error } = await db.from('ia_cache').upsert({
      clave: k, respuesta: texto, modelo,
      vence_el: new Date(Date.now() + ttlMin * 60_000).toISOString(),
      ultimo_uso: new Date().toISOString(),
    }, { onConflict: 'clave' });
    if (error && /ia_cache/i.test(error.message)) tablaCacheViva = false;
  } catch { /* la caché nunca puede tumbar una respuesta */ }
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
  /**
   * Minutos que vale guardar la respuesta. 0 = no se guarda.
   *
   * Sirve para lo que se repite igual: clasificar «Coca-Cola 600ml» da lo
   * mismo hoy que mañana. Lo que depende de los datos del negocio —el chat—
   * se guarda poco o nada, porque la respuesta correcta cambia con las ventas.
   */
  cacheMin?: number;
  /** Parte extra de la clave de caché, para no mezclar negocios. */
  cacheAmbito?: string;
}): Promise<string | null> {
  if (modoIA() === 'demo') return null;
  if (!opts.permiso?.autorizado) return null;

  const proveedor = proveedorIA();
  const modelo = modeloIA();
  const maxTokens = opts.maxTokens ?? 256;

  // 1) ¿Ya la contestamos antes?
  const ttl = Math.max(0, Number(opts.cacheMin ?? 0));
  let k = '';
  if (ttl > 0) {
    k = await clave([proveedor, modelo, String(maxTokens), opts.cacheAmbito ?? '', opts.sistema, opts.mensaje]);
    const guardada = await leerCache(k);
    if (guardada) return guardada;
  }

  try {
    const texto = proveedor === 'gemini'
      ? await pedirAGemini(opts.sistema, opts.mensaje, maxTokens, modelo)
      : await pedirAClaude(opts.sistema, opts.mensaje, maxTokens, modelo);
    if (texto && ttl > 0 && k) await guardarCache(k, texto, ttl, modelo);
    return texto;
  } catch (e: any) {
    // Se registra con el motivo para poder ver DESDE DÓNDE se gastó o falló.
    console.warn(`[ia] falló la consulta al modelo (${opts.permiso?.motivo ?? 'sin motivo'}):`, e?.message);
    return null;
  }
}

async function pedirAClaude(sistema: string, mensaje: string, maxTokens: number, modelo: string): Promise<string | null> {
  const anthropic = await clienteIA();
  const r = await anthropic.messages.create({
    model: modelo,
    max_tokens: maxTokens,
    // Esfuerzo bajo: esto es elegir entre tres opciones dadas, no razonar un
    // problema. Es la diferencia entre centavos y dólares al mes.
    output_config: { effort: 'low' },
    system: sistema,
    messages: [{ role: 'user', content: mensaje }],
  });
  const texto = (r.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('')
    .trim();
  return texto || null;
}

/**
 * GEMINI FLASH, por HTTP directo.
 *
 * Sin SDK a propósito: es una sola petición y sumar un paquete más significa
 * otra dependencia que mantener, que actualizar y que puede romper el
 * despliegue. La llave viaja en la cabecera, nunca en la dirección: en la
 * dirección queda escrita en los registros de cualquier intermediario.
 */
async function pedirAGemini(sistema: string, mensaje: string, maxTokens: number, modelo: string): Promise<string | null> {
  const llave = llaveDe('gemini');
  if (!llave) return null;

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: maxTokens,
    temperature: 0.2,
  };
  /* Los «2.5» piensan antes de contestar y ESO SE PAGA. Para elegir un código
     o redactar dos líneas no hace falta: se apaga. */
  if (/2\.5|3\./.test(modelo)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const ctrl = new AbortController();
  const corte = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': llave },
        signal: ctrl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sistema }] },
          contents: [{ role: 'user', parts: [{ text: mensaje }] }],
          generationConfig,
        }),
      },
    );
    if (!r.ok) {
      const detalle = await r.text().catch(() => '');
      throw new Error(`Gemini respondió ${r.status}: ${detalle.slice(0, 300)}`);
    }
    const j: any = await r.json();
    const texto = (j?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => String(p?.text ?? ''))
      .join('')
      .trim();
    /* Sin texto pero con motivo: casi siempre es que se quedó sin tokens de
       salida o que el filtro de seguridad lo cortó. Hay que poder verlo. */
    if (!texto) {
      const motivo = j?.candidates?.[0]?.finishReason ?? j?.promptFeedback?.blockReason;
      if (motivo) console.warn('[ia] Gemini no devolvió texto:', motivo);
    }
    return texto || null;
  } finally { clearTimeout(corte); }
}
