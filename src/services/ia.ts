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
  /* `gemini-2.5-flash` dejó de estar disponible para cuentas nuevas: Google
     contesta 404 diciendo que hay que pasar a 3.8. Se cambió el valor por
     omisión en vez de pedirle a cada instalación que ponga `IA_MODELO`: un
     modelo descontinuado por omisión es una falla silenciosa esperando. */
  gemini: 'gemini-3.8-flash',
  anthropic: 'claude-haiku-5-5',
};

/**
 * Cuánto se espera una respuesta del modelo.
 *
 * Veinte segundos alcanzan para estas tareas y son el techo de lo que puede
 * esperar una pantalla. Se puede subir con `IA_ESPERA_MS` sin tocar código:
 * en un servidor con la salida a internet lenta, el corte mata consultas que
 * habrían llegado.
 */
const ESPERA_MS = Math.max(5_000, Math.min(60_000, Number(process.env.IA_ESPERA_MS) || 20_000));

/** La versión mayor del modelo de Gemini: «gemini-3.8-flash» → 3. */
function versionGemini(modelo: string): number {
  const m = /gemini-(\d+)/.exec(modelo);
  return m ? Number(m[1]) : 0;
}

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

/**
 * ¿ESTÁ CONECTADA LA API? — una prueba de verdad, no una revisión de variables.
 *
 * Mirar si la llave está puesta no sirve: una llave vencida, un modelo que ya
 * no existe, la facturación sin activar o un cortafuegos dan exactamente el
 * mismo «todo configurado» y después el sistema se cae en silencio al modo
 * local sin que nadie se entere. Por eso esto HABLA con el proveedor y
 * devuelve lo que contestó.
 *
 * A diferencia de `pedirAlModelo`, acá el error NO se traga: el mensaje del
 * proveedor —«API key not valid», «model not found», «quota exceeded»— es
 * justo lo que dice qué arreglar.
 *
 * Es deliberadamente barata: ocho tokens de salida y sin caché (una prueba
 * contestada desde la caché no probaría nada).
 */
export async function probarModelo(timeoutMs = PRESUPUESTO_DIAGNOSTICO.prueba): Promise<{
  ok: boolean; ms: number; respuesta: string | null; error: string | null;
  /** Solo funcionó con el pensamiento apagado: eso es lo que lo hace tardar. */
  sin_pensamiento?: boolean;
}> {
  if (!llaveDe(proveedorIA())) {
    return { ok: false, ms: 0, respuesta: null, error: `Falta la llave: ${proveedorIA() === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'}` };
  }

  const intentar = async (sinPensar: boolean, espera: number) => {
    const arranque = Date.now();
    try {
      const texto = proveedorIA() === 'gemini'
        ? await pedirAGemini('Contestá exactamente: OK', 'Decí OK', 8, modeloIA(), espera, sinPensar)
        : await pedirAClaude('Contestá exactamente: OK', 'Decí OK', 8, modeloIA());
      const ms = Date.now() - arranque;
      /* Conectó pero no dijo nada: pasa cuando el modelo corta por filtro o
         por tope de salida. No es un error de conexión y no se puede reportar
         como si lo fuera, pero tampoco es un «todo bien». */
      if (!texto) return { ok: false, ms, respuesta: null, error: 'El proveedor respondió sin texto (revisá el modelo configurado)' };
      return { ok: true, ms, respuesta: texto.slice(0, 80), error: null };
    } catch (e: any) {
      return { ok: false, ms: Date.now() - arranque, respuesta: null, error: String(e?.message ?? e).slice(0, 300) };
    }
  };

  const normal = await intentar(false, timeoutMs);
  if (normal.ok || proveedorIA() !== 'gemini' || versionGemini(modeloIA()) < 3) return normal;

  /**
   * SI TARDÓ, SE PRUEBA SIN PENSAR.
   *
   * Es la pregunta que queda después de «no contestó a tiempo»: ¿tarda el
   * modelo, o tarda la parte de razonar? Un segundo intento sin pensamiento
   * la contesta en una prueba en vez de en dos despliegues, y si ese sí
   * funciona ya se sabe que alcanza con `IA_SIN_PENSAR=1`.
   */
  const sin = await intentar(true, Math.min(timeoutMs, PRESUPUESTO_DIAGNOSTICO.sinPensar));
  return sin.ok
    ? { ...sin, sin_pensamiento: true }
    : { ...normal, error: `${normal.error} · tampoco contestó con el pensamiento apagado (${sin.error})` };
}

/**
 * EL PRESUPUESTO DE TIEMPO DEL DIAGNÓSTICO.
 *
 * Un diagnóstico que no contesta no diagnostica nada: si el servidor tarda
 * más que lo que la pantalla espera, el usuario ve el error genérico del
 * navegador («la consulta tardó demasiado») y se queda sin saber qué falló,
 * que es exactamente lo contrario de para qué existe esto.
 *
 * Por eso los tres pasos tienen tope y la suma tiene que entrar holgada en
 * los 30 segundos del cliente. La prueba de abajo lo verifica: si alguien
 * sube un tope sin mirar, salta ahí y no en producción.
 */
export const PRESUPUESTO_DIAGNOSTICO = {
  /** Llegar al proveedor (un GET a la ficha del modelo). */
  alcance: 6_000,
  /** Generar una respuesta. Incluye los reintentos por saturación. */
  prueba: 10_000,
  /** El segundo intento, sin pensamiento. */
  sinPensar: 5_000,
  /** Lo que espera la pantalla antes de rendirse. */
  topeCliente: 30_000,
};

/**
 * ¿SE LLEGA AL PROVEEDOR? — sin generar nada.
 *
 * Es la mitad que faltaba del diagnóstico. «Se agotó la espera» tiene dos
 * causas que se arreglan al revés: el modelo tardó más de la cuenta, o el
 * servidor no tiene salida hacia Google y la conexión se quedó colgada hasta
 * el corte. Desde afuera se ven idénticas.
 *
 * Esto pregunta por la FICHA del modelo —un GET que no genera texto, no
 * cuesta y contesta en milisegundos—. Si esto anda y la generación no, el
 * problema es el modelo o la lentitud; si esto tampoco anda, es la salida a
 * internet o la llave.
 *
 * De paso confirma que el modelo configurado EXISTE para esta cuenta, que es
 * exactamente lo que falló con el 2.5.
 */
export async function alcanzaProveedor(timeoutMs = PRESUPUESTO_DIAGNOSTICO.alcance): Promise<{
  ok: boolean; ms: number; estado: number | null; error: string | null;
}> {
  const arranque = Date.now();
  const proveedor = proveedorIA();
  const llave = llaveDe(proveedor);
  if (!llave) return { ok: false, ms: 0, estado: null, error: 'Sin llave' };

  const ctrl = new AbortController();
  const corte = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = proveedor === 'gemini'
      ? await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modeloIA())}`,
        { headers: { 'x-goog-api-key': llave }, signal: ctrl.signal })
      : await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(modeloIA())}`,
        { headers: { 'x-api-key': llave, 'anthropic-version': '2023-06-01' }, signal: ctrl.signal });
    const ms = Date.now() - arranque;
    if (r.ok) return { ok: true, ms, estado: r.status, error: null };
    const detalle = await r.text().catch(() => '');
    return { ok: false, ms, estado: r.status, error: `${r.status}: ${detalle.slice(0, 200)}` };
  } catch (e: any) {
    const ms = Date.now() - arranque;
    const corto = e?.name === 'AbortError' || /aborted/i.test(String(e?.message ?? ''));
    return {
      ok: false, ms, estado: null,
      /* Que ni la consulta más barata llegue en diez segundos no es lentitud:
         es que no hay salida hacia el proveedor. Decirlo así ahorra horas. */
      error: corto
        ? `No se llegó a ${proveedor} en ${Math.round(timeoutMs / 1000)} s: el servidor no parece tener salida hacia ahí`
        : String(e?.message ?? e).slice(0, 200),
    };
  } finally { clearTimeout(corte); }
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
async function pedirAGemini(sistema: string, mensaje: string, maxTokens: number, modelo: string, timeoutMs = ESPERA_MS, sinPensar = false): Promise<string | null> {
  const llave = llaveDe('gemini');
  if (!llave) return null;

  /**
   * LA CONFIGURACIÓN CAMBIÓ CON GEMINI 3.
   *
   *  · `thinkingBudget` (un número de tokens) se reemplazó por
   *    `thinkingLevel`, un enum: low | medium | high. En 3.8 «minimal» ya no
   *    existe y devuelve error, así que lo más bajo que se puede pedir es
   *    «low» —que es justo lo que necesitan estas tareas: elegir un código
   *    entre cuatro candidatos no requiere pensar, requiere leer—.
   *  · `temperature`, `topP` y `topK` quedaron deprecados y hay que sacarlos.
   *
   * Y como ahora el modelo piensa aunque sea un poco, el tope de salida no
   * puede ser de ocho tokens: lo que piensa sale del mismo presupuesto y la
   * respuesta llegaría vacía con `finishReason: MAX_TOKENS`. Por eso hay un
   * piso cuando el modelo es de los que piensan.
   */
  const v3 = versionGemini(modelo) >= 3;
  /* `IA_SIN_PENSAR=1` apaga el pensamiento sin tocar código. Es la salida
     cuando resulta ser lo que hace tardar al modelo: estas tareas no lo
     necesitan y esperar quince segundos por un CAByS no sirve de nada. */
  const nada = sinPensar || String(process.env.IA_SIN_PENSAR ?? '').trim() === '1';
  const generationConfig: Record<string, unknown> = v3
    ? { maxOutputTokens: nada ? maxTokens : Math.max(maxTokens, 512),
        ...(nada ? {} : { thinkingConfig: { thinkingLevel: 'low' } }) }
    : { maxOutputTokens: maxTokens, temperature: 0.2, ...(/2\.5/.test(modelo) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) };

  const ctrl = new AbortController();
  const corte = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const llamar = async (cfg: Record<string, unknown>) => fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': llave },
        signal: ctrl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sistema }] },
          contents: [{ role: 'user', parts: [{ text: mensaje }] }],
          generationConfig: cfg,
        }),
      },
    );

    /**
     * SATURACIÓN: SE REINTENTA, NO SE RINDE.
     *
     * Un 503 («high demand») o un 429 no son un error de configuración: son
     * el proveedor pidiendo que se vuelva a intentar. Sin reintento, un pico
     * de dos segundos deja sin IA a una importación entera y el negocio
     * termina con el catálogo clasificado a mano sin que nadie sepa por qué.
     *
     * Dos reintentos cortos con espera creciente, y solo mientras quede
     * tiempo del presupuesto: esperar más que el corte sería inventar una
     * demora propia encima de la del proveedor.
     */
    const REINTENTABLES = [429, 500, 502, 503, 504];
    const arranque = Date.now();
    let r = await llamar(generationConfig);
    for (let intento = 1; intento <= 2 && !r.ok && REINTENTABLES.includes(r.status); intento++) {
      /* `Retry-After` manda si viene: el proveedor sabe mejor que nosotros
         cuánto tarda en descongestionarse. */
      const dicho = Number(r.headers?.get?.('retry-after')) * 1000;
      const espera = Number.isFinite(dicho) && dicho > 0
        ? Math.min(dicho, 5_000)
        : intento * 800 + Math.floor(Math.random() * 400);
      if (Date.now() - arranque + espera > timeoutMs - 1_000) break;
      console.warn(`[ia] Gemini ${r.status}: saturado, reintento ${intento} en ${espera} ms`);
      await new Promise(res => setTimeout(res, espera));
      r = await llamar(generationConfig);
    }
    /*
     * SI LA PELEA ES POR EL CAMPO DE PENSAR, SE PREGUNTA SIN ÉL.
     *
     * Las opciones de razonamiento vienen cambiando de nombre en cada
     * versión, y cuál acepta cada modelo no está documentado parejo. Un 400
     * por ese campo dejaría al sistema entero sin IA por una preferencia de
     * costo: se reintenta una vez sin él, que es peor para la cuenta pero
     * mejor que no contestar.
     */
    if (!r.ok && r.status === 400 && generationConfig.thinkingConfig) {
      const detalle = await r.clone().text().catch(() => '');
      if (/thinking/i.test(detalle)) {
        const { thinkingConfig: _fuera, ...sinPensar } = generationConfig;
        console.warn('[ia] Gemini rechazó la opción de pensamiento; se reintenta sin ella:', detalle.slice(0, 160));
        r = await llamar(sinPensar);
      }
    }
    if (!r.ok) {
      const detalle = await r.text().catch(() => '');
      /* El código va por delante y en palabras: «503» a secas manda a revisar
         la llave, que es exactamente lo que NO hay que tocar. */
      if (REINTENTABLES.includes(r.status)) {
        throw new Error(`El modelo está saturado del lado de ${r.status === 429 ? 'tu cuota' : 'Google'} (${r.status}). `
          + `Se reintentó 3 veces. ${detalle.slice(0, 200)}`);
      }
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
  } catch (e: any) {
    /* «This operation was aborted» no le dice nada a nadie: es NUESTRO corte
       de espera, no una respuesta de Google. Hay que decir que se agotó el
       tiempo y cuánto se esperó, porque eso se arregla distinto que una llave
       mala —puede ser el modelo lento o el servidor sin salida a internet—. */
    if (e?.name === 'AbortError' || /aborted/i.test(String(e?.message ?? ''))) {
      throw new Error(`No contestó en ${Math.round(timeoutMs / 1000)} s (se agotó la espera)`);
    }
    throw e;
  } finally { clearTimeout(corte); }
}
