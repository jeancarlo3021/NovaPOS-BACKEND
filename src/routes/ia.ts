import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { respuesta, modoIA, pedirAlModelo, proveedorIA, modeloIA, probarModelo, alcanzaProveedor, modelosDisponibles } from '../services/ia.js';
import { estadoCreditos, tomarCredito, devolverCredito } from '../services/creditosIA.js';
import { sugerirCabys } from './cabys.js';
import { planFeatureLabels } from '../services/emailService.js';

/**
 * Las funciones de IA del sistema, hoy en MODO DEMOSTRACIÓN (ver services/ia.ts).
 *
 * Nada de acá llama a un modelo: las respuestas se arman con los datos del
 * propio negocio. Eso tiene una ventaja que no es solo el costo — en una
 * demostración, los números que salen son los de VERDAD del negocio, no un
 * ejemplo inventado, y eso es justo lo que convence a un cliente.
 */
export const ia = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const diaCR = (d: Date | string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
const money = (n: number) => `₡${Math.round(Number(n) || 0).toLocaleString('es-CR')}`;
/** Cantidades: los decimales de punto flotante no se le muestran a nadie. */
const cant = (n: number) => Number(n || 0).toLocaleString('es-CR', { maximumFractionDigits: 2 });
const norm = (s: string) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ══════════════════════════════════════════════════════════════════════════
// GET /estado — ¿en qué modo está?
// ══════════════════════════════════════════════════════════════════════════
ia.get('/estado', async (c) => ok(c, {
  modo: modoIA(),
  // La pantalla lo muestra: quien pregunta tiene derecho a saber si le
  // contestó el sistema con sus datos o un modelo, y cuál.
  proveedor: modoIA() === 'real' ? proveedorIA() : null,
  // Y cuántas consultas al modelo le quedan este mes.
  creditos: await estadoCreditos(c.get('tenantId')),
}));

// ══════════════════════════════════════════════════════════════════════════
// GET /diagnostico — ¿ESTÁ CONECTADA LA API?
// ══════════════════════════════════════════════════════════════════════════

/**
 * El chequeo de conexión: configuración + una llamada REAL al proveedor.
 *
 * Revisar las variables de entorno no alcanza. Una llave vencida, un modelo
 * que ya no existe, la facturación sin activar o la cuota agotada se ven
 * exactamente igual que «todo configurado», y el sistema —que por diseño
 * nunca se cae por culpa del modelo— sigue contestando con el buscador local
 * sin que nadie note que la IA no está haciendo nada.
 *
 * Por eso acá se le habla al proveedor de verdad y se devuelve lo que
 * contestó, con el error textual si falló: «API key not valid» y «model not
 * found» se arreglan distinto, y un «no funciona» no distingue.
 *
 * La llave NUNCA se devuelve, ni un pedazo: esto lo ve una pantalla, y una
 * pantalla se comparte en una captura. Solo se dice si está y de qué largo,
 * que es lo que hace falta para saber si quedó pegada a medias.
 */
ia.get('/diagnostico', async (c) => {
  try {
    /* Solo el dueño o un administrador. La prueba gasta —poco, pero gasta— y
       además el detalle del error dice cómo está armado el servidor. */
    const rol = String(c.get('role') ?? '');
    if (!['owner', 'admin'].includes(rol)) return fail(c, 'Solo el dueño puede probar la conexión', 403);

    const proveedor = proveedorIA();
    const llave = String((proveedor === 'gemini' ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY) ?? '').trim();
    const pedido = String(process.env.IA_MODO ?? '').trim().toLowerCase();

    /* La prueba solo se corre si hay con qué: sin llave ya se sabe que falla,
       y con el modo en demostración una llamada de verdad sería gastar por
       algo que el sistema no va a usar igual. */
    /* DOS PRUEBAS, en orden de baratura. Primero si se LLEGA al proveedor
       (un GET a la ficha del modelo: no genera nada, no cuesta y contesta en
       milisegundos) y después si GENERA. Con las dos se puede decir qué pasa:
       «se agotó la espera» a secas puede ser el modelo lento o el servidor
       sin salida a internet, y se arreglan al revés. */
    const alcance = llave
      ? await alcanzaProveedor()
      : { ok: false, ms: 0, estado: null as number | null, error: 'Sin llave' };

    const prueba = llave && pedido === 'real' && alcance.ok
      ? await probarModelo()
      : { ok: false, ms: 0, respuesta: null, error: null as string | null };

    /**
     * «¿Y ENTONCES CUÁL PONGO?» — la llave ya sabe la respuesta.
     *
     * Se le pregunta en los dos casos en que hace falta, que al principio
     * cubrían solo uno:
     *
     *  · el modelo NO EXISTE para esta cuenta (404 al buscar su ficha). Es
     *    justo cuando más se necesita la lista, y era el caso que quedaba
     *    afuera: se decía «poné otro en IA_MODELO» sin decir cuál, que es
     *    mandar a alguien a adivinar nombres;
     *  · el modelo existe pero no logra contestar (saturado, sin permiso).
     *
     * No se pregunta cuando no hay llave o no hay salida a internet: ahí la
     * lista tampoco va a llegar y serían segundos tirados.
     */
    const noExiste = alcance.estado === 404;
    const alternativas = llave && (noExiste || (alcance.ok && !prueba.ok))
      ? await modelosDisponibles() : [];

    /* QUÉ HAY QUE HACER, en una línea. Un diagnóstico que deja al usuario
       interpretando cuatro banderas no sirve de nada. */
    const queHacer = !llave
      ? `Falta la llave ${proveedor === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} en el servidor.`
      : pedido !== 'real'
        ? 'La llave está, pero falta IA_MODO=real en el servidor: por seguridad la IA no se enciende sola.'
        /* El alcance manda sobre la generación: si no se llega, decir «el
           modelo no contestó» mandaría a revisar el modelo cuando lo que
           falla es la salida a internet o la llave. */
        : !alcance.ok
          ? (alcance.estado === 404
              ? `El modelo «${modeloIA()}» no existe para esta cuenta. `
                + (alternativas.length > 0
                    ? `Poné en IA_MODELO uno de los ${alternativas.length} que sí podés usar (abajo), o borrá la variable para volver al de fábrica.`
                    : 'Borrá la variable IA_MODELO para volver al modelo de fábrica.')
              : alcance.estado === 401 || alcance.estado === 403
                ? `El proveedor rechazó la llave (${alcance.estado}). Revisá que sea de la API de Gemini y que el proyecto la tenga habilitada.`
                : `No se pudo llegar al proveedor: ${alcance.error ?? 'sin detalle'}`)
          : prueba.ok
            ? ((prueba as any).sin_pensamiento
                /* Contesta, pero solo con el pensamiento apagado: el sistema
                   no está roto, está esperando de más por algo que estas
                   tareas no necesitan. */
                ? 'El modelo contesta, pero la parte de «pensar» lo hace tardar demasiado. Poné IA_SIN_PENSAR=1 en el servidor: estas tareas no la necesitan.'
                : null)
            /* SATURADO NO ES MAL CONFIGURADO. Mandar a revisar la llave
               cuando Google está pidiendo que se intente más tarde es hacer
               perder la tarde tocando lo único que estaba bien. */
            : /saturado|UNAVAILABLE|high demand|RESOURCE_EXHAUSTED/i.test(prueba.error ?? '')
              ? 'No es tu configuración: el modelo está saturado del lado de Google y ya se reintentó solo. '
                + (alternativas.length > 0
                    ? `Poné otro en IA_MODELO —tu llave puede usar ${alternativas.length}— o habilitá facturación en el proyecto de Google. `
                      + 'Con IA_MODELO_RESPALDO el sistema se pasa solo al segundo cuando el primero está lleno.'
                    : 'Probá de nuevo en unos minutos, o habilitá facturación en el proyecto de Google.')
            : /espera/i.test(prueba.error ?? '')
              /* Se llega pero no genera a tiempo: eso ya no es conexión. */
              ? `Se llega a ${proveedor} (${alcance.ms} ms) pero la respuesta no llegó a tiempo. Probá de nuevo; si sigue, subí IA_ESPERA_MS en el servidor.`
              : `El proveedor no contestó bien: ${prueba.error ?? 'sin detalle'}`;

    return ok(c, {
      /* Contestar solo sin pensamiento NO es estar conectada del todo: con la
         configuración actual el sistema sigue sin recibir respuestas. */
      conectada: modoIA() === 'real' && prueba.ok && !(prueba as any).sin_pensamiento,
      modo: modoIA(),
      /* Lo PEDIDO y lo EFECTIVO por separado: con IA_MODO=real y sin llave,
         el sistema queda en demostración y decir solo «demo» esconde que
         alguien ya intentó encenderla. */
      modo_pedido: pedido || '(sin poner)',
      proveedor,
      modelo: modeloIA(),
      llave: { presente: !!llave, largo: llave.length },
      /** ¿Se LLEGA al proveedor? (sin generar nada) */
      alcance,
      /** Los modelos que esta llave puede usar, por si hay que cambiar. */
      alternativas,
      prueba,
      que_hacer: queHacer,
      /* Para qué se usa hoy, así la pantalla puede decirlo sin inventar. */
      usos: ['CAByS en la carga de productos', 'Asistente del tablero'],
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// PASO 4 — PREGUNTAR EN ESPAÑOL
// ══════════════════════════════════════════════════════════════════════════

/**
 * Qué período pide la pregunta.
 *
 * Sin fecha explícita se asume el mes en curso, que es lo que alguien quiere
 * decir cuando pregunta «¿cómo voy?».
 */
function periodoDe(pregunta: string): { desde: string; hasta: string; etiqueta: string } {
  const p = norm(pregunta);
  const hoyCR = diaCR(new Date());
  const menos = (dias: number) => diaCR(new Date(Date.now() - dias * 86_400_000));
  if (/\bhoy\b/.test(p)) return { desde: hoyCR, hasta: hoyCR, etiqueta: 'hoy' };
  if (/\bayer\b/.test(p)) return { desde: menos(1), hasta: menos(1), etiqueta: 'ayer' };
  if (/semana pasada/.test(p)) return { desde: menos(14), hasta: menos(7), etiqueta: 'la semana pasada' };
  if (/\bsemana\b/.test(p)) return { desde: menos(7), hasta: hoyCR, etiqueta: 'los últimos 7 días' };
  if (/mes pasado/.test(p)) {
    const [a, m] = hoyCR.split('-').map(Number);
    const antes = m === 1 ? { a: a - 1, m: 12 } : { a, m: m - 1 };
    const ultimo = new Date(Date.UTC(antes.a, antes.m, 0)).getUTCDate();
    return {
      desde: `${antes.a}-${String(antes.m).padStart(2, '0')}-01`,
      hasta: `${antes.a}-${String(antes.m).padStart(2, '0')}-${ultimo}`,
      etiqueta: 'el mes pasado',
    };
  }
  if (/\baño\b|\banual\b/.test(p)) return { desde: menos(365), hasta: hoyCR, etiqueta: 'los últimos 12 meses' };
  /**
   * EL MES EMPIEZA EL 1, también en Costa Rica.
   *
   * Se armaba un `Date` a medianoche UTC del día 1 y después se formateaba en
   * hora de Costa Rica: a las 00:00 UTC acá son las 18:00 del día ANTERIOR, así
   * que «este mes» arrancaba el 31 del mes pasado. El 1 de noviembre el
   * asistente decía «del 2026-10-31 al 2026-11-01» y metía las ventas del
   * último día del mes anterior en el mes nuevo.
   *
   * La fecha se arma con el año y el mes que YA vienen en hora de Costa Rica.
   */
  return { desde: `${hoyCR.slice(0, 7)}-01`, hasta: hoyCR, etiqueta: 'este mes' };
}

/**
 * El período ANTERIOR del mismo largo.
 *
 * «Vendí ₡800.000 este mes» no dice nada solo: ¿es bueno o malo? La respuesta
 * útil es «₡800.000, 12% más que el mes pasado». Se compara contra un tramo
 * del mismo largo terminando justo antes, no contra «el mes calendario
 * anterior», porque si hoy es 5 comparar 5 días contra 30 da una caída del 80%
 * que no existe y asusta a cualquiera.
 */
function periodoAnterior(desde: string, hasta: string): { desde: string; hasta: string } {
  const d0 = new Date(desde + 'T12:00:00').getTime();
  const d1 = new Date(hasta + 'T12:00:00').getTime();
  const largo = Math.max(86_400_000, d1 - d0 + 86_400_000);
  return { desde: diaCR(new Date(d0 - largo)), hasta: diaCR(new Date(d0 - 86_400_000)) };
}

/** Cómo se dice una variación en castellano, sin falsa precisión. */
function variacion(ahora: number, antes: number): string | null {
  // Devuelve una frase COMPLETA, no un pedazo: antes se anteponía «Es » y
  // salía «Es no hay con qué comparar», que se lee como un error del sistema.
  if (antes <= 0) return ahora > 0 ? 'En el período anterior no hubo ventas, así que no hay con qué comparar.' : null;
  const pct = ((ahora - antes) / antes) * 100;
  if (Math.abs(pct) < 1) return 'Es prácticamente igual que el período anterior.';
  const signo = pct > 0 ? 'más' : 'menos';
  return `Es un ${Math.abs(Math.round(pct))}% ${signo} que el período anterior (${money(antes)}).`;
}

/** Facturas no anuladas del período (paginadas: Supabase corta en 1000). */
async function ventasDe(tenantId: string, desde: string, hasta: string) {
  const filas: any[] = [];
  const desdeISO = `${desde}T00:00:00`;
  const hastaISO = `${hasta}T23:59:59`;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('invoices')
      .select('id, total, subtotal, tax_amount, issued_at, status, payment_method, customer_name')
      .eq('tenant_id', tenantId).neq('status', 'cancelled')
      .gte('issued_at', desdeISO).lte('issued_at', hastaISO)
      .order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    filas.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return filas;
}

/**
 * Lo que el modelo necesita saber del negocio para contestar algo suelto.
 *
 * Tres datos y nada más. La tentación es mandarle el catálogo, los clientes y
 * las ventas del mes «por si acaso»: eso se paga en CADA pregunta y multiplica
 * la cuenta por diez sin mejorar casi nada, porque lo que de verdad necesita
 * datos ya lo contesta la base con números exactos.
 */
async function contextoDelNegocio(tenantId: string): Promise<string> {
  try {
    const { data: t } = await db.from('tenants').select('name').eq('id', tenantId).maybeSingle();
    const { count } = await db.from('products')
      .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
    return [
      `Negocio: ${(t as any)?.name ?? 'sin nombre'}.`,
      `Productos en el catálogo: ${count ?? 0}.`,
      'País: Costa Rica (colones, IVA 13%, facturación electrónica de Hacienda).',
    ].join(' ');
  } catch { return 'Negocio en Costa Rica (colones, IVA 13%).'; }
}

/**
 * La pregunta que las reglas no supieron contestar, al modelo.
 *
 * Instrucciones cortas y tope de salida bajo: esto es un asistente de un punto
 * de venta, no un ensayista. Y se le PROHÍBE inventar cifras: los números del
 * negocio los da la base, no él; si se los inventa, alguien va a tomar una
 * decisión con un número falso.
 */
async function preguntarAlModelo(
  tenantId: string, pregunta: string, historial: Array<{ rol: string; texto: string }>,
): Promise<string | null> {
  const contexto = await contextoDelNegocio(tenantId);
  const charla = historial.length
    ? `\n\nConversación previa:\n${historial.map(m => `${m.rol === 'asistente' ? 'Vos' : 'Usuario'}: ${m.texto}`).join('\n')}`
    : '';
  return pedirAlModelo({
    sistema: [
      'Sos el asistente de NovaPOS, un sistema de punto de venta y facturación de Costa Rica.',
      'Contestás en español de Costa Rica, en dos o tres oraciones, sin rodeos y sin saludar.',
      'NUNCA inventes cifras del negocio (ventas, deudas, existencias): si te piden un número que no',
      'tenés, decí que lo pregunten así: «¿cuánto vendí este mes?», «¿qué se está acabando?»,',
      '«¿cuánto me deben?» — esas las contesta el sistema con datos reales.',
      'Si la pregunta no tiene que ver con el negocio ni con el sistema, decilo en una línea.',
      contexto,
    ].join(' '),
    mensaje: `${pregunta}${charla}`,
    // Respuesta corta: se paga por lo que sale. Dos o tres oraciones entran acá.
    maxTokens: 320,
    permiso: { motivo: 'chat del asistente', autorizado: true },
    /* Diez minutos de caché por negocio: alcanza para que «¿cómo hago una nota
       de crédito?» —que se pregunta en tandas— se pague una sola vez, y es
       poco como para no servir algo viejo si los datos cambiaron. */
    cacheMin: 10,
    cacheAmbito: tenantId,
  });
}

/**
 * POST /preguntar  { pregunta }
 *
 * En modo demostración NO interviene ningún modelo: se reconoce de qué habla
 * la pregunta y se contesta con una consulta a la base. Por eso los números
 * son reales y la respuesta dice siempre de dónde salieron: un asistente que
 * tira una cifra sin decir de qué período ni sobre cuántas facturas no sirve
 * para tomar ninguna decisión.
 */
ia.post('/preguntar', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const cuerpo: any = await c.req.json().catch(() => ({}));
    const texto = String(cuerpo?.pregunta ?? '').trim();
    if (!texto) return fail(c, 'Escribí una pregunta', 422);
    /* Las últimas vueltas de la conversación, para que el chat entienda un
       «¿y el mes pasado?». Se recortan: mandar la charla entera se paga en
       cada mensaje y a la cuarta pregunta ya cuesta más que la respuesta. */
    const historial: Array<{ rol: string; texto: string }> = Array.isArray(cuerpo?.historial)
      ? cuerpo.historial.slice(-6).map((m: any) => ({
          rol: m?.rol === 'asistente' ? 'asistente' : 'usuario',
          texto: String(m?.texto ?? '').slice(0, 500),
        })).filter((m: any) => m.texto)
      : [];

    const p = norm(texto);
    const { desde, hasta, etiqueta } = periodoDe(texto);

    // ── ¿De qué habla? ──
    const esVentas = /vend|venta|factur|ingres|cuanto hice|cuanto llev/.test(p);
    const esProductos = /producto|plato|mas vendido|mejor vend|que se vende/.test(p);
    const esDeudas = /deben|cobrar|pendiente|credito|deuda/.test(p);
    const esPagar = /pagar|proveedor|debo/.test(p);
    // «se está acabando», «se acaba», «por acabarse», «qué hay que reponer»…
    const esStock = /stock|existencia|acab|agotad|repon|minimo|bajo de/.test(p);
    const esClientes = /client|quien me compra|quien compra|mejor comprador/.test(p);
    const esGastos = /gast|egres|compr[eé]|cuanto sali|salida de plata/.test(p);
    const esCabys = /\bcabys\b|\bcaby\b|codigo de hacienda|código de hacienda/.test(p);

    /**
     * CAByS — se contesta con los datos, no con un modelo.
     *
     * «Ayudame con lo del CAByS» caía en «todavía no sé contestar eso», que es
     * lo más inútil posible: es la duda número uno de quien arranca con
     * facturación electrónica, y el sistema tiene todo para responderla —cuántos
     * productos le faltan y dónde se pone—.
     */
    if (esCabys) {
      /* Los productos borrados se marcan con `deleted_at`, no con un
         `is_active` —que en esta tabla no existe—: filtrando por él la cuenta
         daba cero siempre y el asistente contestaba que no había nada que
         hacer con el catálogo lleno. */
      const [{ count: total }, { count: sinCabys }] = await Promise.all([
        db.from('products').select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId).is('deleted_at', null),
        db.from('products').select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId).is('deleted_at', null).or('cabys_code.is.null,cabys_code.eq.'),
      ]);
      const faltan = Number(sinCabys ?? 0);
      const hay = Number(total ?? 0);

      return ok(c, respuesta({
        respuesta: hay === 0
          ? 'Todavía no tenés productos cargados, así que no hay ningún CAByS pendiente.'
          : faltan === 0
            ? `Todos tus productos (${hay}) ya tienen su código CAByS. No hay nada pendiente.`
            : faltan === 1
              ? `Te falta 1 producto de ${hay} con código CAByS.`
              : `Te faltan ${faltan} de ${hay} productos con código CAByS.`,
        detalle: [
          'El CAByS es el código con el que Hacienda identifica cada producto o servicio; sin él, el comprobante electrónico se rechaza.',
          'Dónde se pone: Inventario → el producto → el campo CAByS. Escribí el nombre y el buscador te propone los códigos que calzan, con su IVA.',
          faltan > 0
            ? 'Si son muchos, pedile al administrador que los cargue en tanda desde el panel: ahí se asignan de a cientos y se pueden marcar todos los que llevan el mismo código.'
            : '',
        ].filter(Boolean).join('\n'),
        fuente: `Catálogo del negocio: ${hay} producto(s).`,
        no_entendida: false,
        sugerencias: ['¿Qué se está acabando?', '¿Cuánto vendí este mes?'],
      }));
    }

    if (esVentas && !esProductos) {
      const ventas = await ventasDe(tenantId, desde, hasta);
      const total = ventas.reduce((s, v) => s + Number(v.total || 0), 0);
      const iva = ventas.reduce((s, v) => s + Number(v.tax_amount || 0), 0);
      const porMetodo: Record<string, number> = {};
      for (const v of ventas) {
        const k = String(v.payment_method ?? 'otro');
        porMetodo[k] = (porMetodo[k] ?? 0) + Number(v.total || 0);
      }
      const detalle = Object.entries(porMetodo).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}: ${money(v)}`).join(' · ');

      // La comparación va SIEMPRE, no solo si la preguntan: es lo que
      // convierte una cifra en una noticia.
      const prev = periodoAnterior(desde, hasta);
      let comparacion: string | null = null;
      try {
        const antes = await ventasDe(tenantId, prev.desde, prev.hasta);
        comparacion = variacion(total, antes.reduce((s2, v) => s2 + Number(v.total || 0), 0));
      } catch { /* sin comparación la respuesta sirve igual */ }

      return ok(c, respuesta({
        respuesta: ventas.length === 0
          ? `No hay ventas registradas ${etiqueta}.`
          : `${etiqueta.charAt(0).toUpperCase()}${etiqueta.slice(1)} vendiste ${money(total)} en ${ventas.length} factura(s), `
            + `con un promedio de ${money(total / ventas.length)} por venta.`
            + (comparacion ? ` ${comparacion}` : '')
            + (iva > 0 ? ` IVA incluido: ${money(iva)}.` : ''),
        detalle: detalle || null,
        fuente: `Facturas no anuladas del ${desde} al ${hasta}`
          + (comparacion ? `, comparadas con el ${prev.desde} al ${prev.hasta}` : '') + '.',
      }));
    }

    if (esProductos) {
      const ventas = await ventasDe(tenantId, desde, hasta);
      const ids = ventas.map(v => v.id);
      const porProducto = new Map<string, { nombre: string; cant: number; monto: number }>();
      const lineas: any[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await db.from('invoice_items')
          .select('product_id, product_name, quantity, subtotal').in('invoice_id', ids.slice(i, i + 200));
        lineas.push(...(data ?? []));
      }
      /**
       * El nombre se busca en el PRODUCTO cuando la línea no lo trae.
       *
       * Hay negocios —los de distribución— cuyas líneas se guardan sin
       * `product_name`. Sin esto, todo caía en una bolsa llamada «Sin nombre»
       * y la respuesta al «¿qué me deja más plata?» era un solo renglón
       * inútil, que es exactamente lo que no se puede mostrar en una demo.
       */
      const sinNombre = [...new Set(lineas.filter(l => !l.product_name && l.product_id).map(l => String(l.product_id)))];
      const nombreDe = new Map<string, string>();
      for (let i = 0; i < sinNombre.length; i += 200) {
        const { data } = await db.from('products').select('id, name').in('id', sinNombre.slice(i, i + 200));
        for (const x of (data ?? []) as any[]) nombreDe.set(String(x.id), String(x.name));
      }
      for (const it of lineas) {
        const k = String(it.product_name ?? nombreDe.get(String(it.product_id)) ?? 'Sin nombre');
        const a = porProducto.get(k) ?? { nombre: k, cant: 0, monto: 0 };
        a.cant += Number(it.quantity || 0);
        a.monto += Number(it.subtotal || 0);
        porProducto.set(k, a);
      }
      const top = [...porProducto.values()].sort((a, b) => b.monto - a.monto).slice(0, 5);
      return ok(c, respuesta({
        respuesta: top.length === 0
          ? `No hay ventas ${etiqueta} para comparar productos.`
          : `Lo que más plata dejó ${etiqueta}: ${top.map((t, i) => `${i + 1}) ${t.nombre} (${cant(t.cant)} ${t.cant === 1 ? 'unidad' : 'unidades'}, ${money(t.monto)})`).join(' · ')}.`,
        detalle: null,
        fuente: `Líneas de las facturas del ${desde} al ${hasta}.`,
      }));
    }

    if (esDeudas) {
      const { data } = await db.from('accounts_receivable')
        .select('customer_name, total_amount, paid_amount, due_date, status')
        .eq('tenant_id', tenantId).neq('status', 'paid');
      const pend = (data ?? []).map((r: any) => ({
        cliente: r.customer_name, saldo: Number(r.total_amount || 0) - Number(r.paid_amount || 0),
        vence: r.due_date,
      })).filter(x => x.saldo > 0.5);
      const total = pend.reduce((s, x) => s + x.saldo, 0);
      const hoy = diaCR(new Date());
      const vencidas = pend.filter(x => x.vence && String(x.vence) < hoy);
      const top = [...pend].sort((a, b) => b.saldo - a.saldo).slice(0, 5);
      return ok(c, respuesta({
        respuesta: pend.length === 0
          ? 'Nadie te debe: no hay cuentas por cobrar pendientes.'
          : `Te deben ${money(total)} en ${pend.length} cuenta(s), de las cuales ${vencidas.length} ya venció(eron).`,
        detalle: top.length ? top.map(x => `${x.cliente ?? 'Sin nombre'}: ${money(x.saldo)}`).join(' · ') : null,
        fuente: 'Cuentas por cobrar sin saldar.',
      }));
    }

    if (esPagar) {
      const { data } = await db.from('accounts_payable')
        .select('supplier_name, total_amount, paid_amount, due_date, status')
        .eq('tenant_id', tenantId).neq('status', 'paid');
      const pend = (data ?? []).map((r: any) => ({
        prov: r.supplier_name, saldo: Number(r.total_amount || 0) - Number(r.paid_amount || 0), vence: r.due_date,
      })).filter(x => x.saldo > 0.5);
      const total = pend.reduce((s, x) => s + x.saldo, 0);
      return ok(c, respuesta({
        respuesta: pend.length === 0
          ? 'No tenés cuentas por pagar pendientes registradas.'
          : `Debés ${money(total)} a ${pend.length} proveedor(es).`,
        detalle: pend.slice(0, 5).map(x => `${x.prov ?? 'Sin nombre'}: ${money(x.saldo)}${x.vence ? ` (vence ${x.vence})` : ''}`).join(' · ') || null,
        fuente: 'Cuentas por pagar sin saldar.',
      }));
    }

    if (esClientes) {
      const ventas = await ventasDe(tenantId, desde, hasta);
      const porCliente = new Map<string, { n: number; monto: number }>();
      for (const v of ventas) {
        // Las ventas de mostrador no tienen cliente: agruparlas como «Contado»
        // y no como «Sin nombre» es lo que hace que la respuesta se entienda.
        const k = String(v.customer_name ?? '').trim() || 'Contado (sin cliente)';
        const a = porCliente.get(k) ?? { n: 0, monto: 0 };
        a.n += 1; a.monto += Number(v.total || 0);
        porCliente.set(k, a);
      }
      const top = [...porCliente.entries()].sort((a, b) => b[1].monto - a[1].monto).slice(0, 5);
      const identificados = [...porCliente.entries()].filter(([k]) => !k.startsWith('Contado'));
      return ok(c, respuesta({
        respuesta: top.length === 0
          ? `No hay ventas ${etiqueta} para ver quién compra.`
          : `${etiqueta.charAt(0).toUpperCase()}${etiqueta.slice(1)} te compraron ${porCliente.size} cliente(s) distintos. `
            + `El que más dejó: ${top[0][0]} con ${money(top[0][1].monto)} en ${top[0][1].n} compra(s).`
            + (identificados.length === 0
              ? ' Ojo: ninguna venta tiene cliente asignado, así que no se puede seguir a nadie en el tiempo.'
              : ''),
        detalle: top.map(([k, v]) => `${k}: ${money(v.monto)} (${v.n})`).join(' · '),
        fuente: `Facturas no anuladas del ${desde} al ${hasta}, agrupadas por cliente.`,
      }));
    }

    if (esGastos) {
      /**
       * Gastos del período.
       *
       * Se leen de `expenses` y, si la tabla no existe en esta instalación, la
       * respuesta lo DICE en vez de contestar «₡0»: un cero inventado sobre
       * una tabla que no existe es peor que un «no sé», porque se parece a un
       * dato.
       */
      let filas: any[] | null = null;
      try {
        // Las columnas son `date` y `category_id`, no `expense_date` ni
        // `category`. Lo digo acá porque equivocarse NO daba un error visible:
        // caía en el catch y la respuesta era «el módulo de gastos no está
        // disponible» sobre una tabla que existe y tiene datos. Un «no hay»
        // falso es peor que un error, porque nadie lo va a ir a revisar.
        const { data, error } = await db.from('expenses')
          .select('amount, date, category_id, description')
          .eq('tenant_id', tenantId).gte('date', desde).lte('date', hasta).limit(5000);
        if (error) throw new Error(error.message);
        filas = data ?? [];
      } catch { filas = null; }

      if (filas === null) {
        return ok(c, respuesta({
          respuesta: 'No puedo ver los gastos en este negocio: el módulo de gastos no está disponible.',
          detalle: null, fuente: null,
        }));
      }
      const total = filas.reduce((s2, g) => s2 + Number(g.amount || 0), 0);
      // El nombre de la categoría, no su id: «3f2a-…» no le dice nada a nadie.
      const nombreCat = new Map<string, string>();
      try {
        const { data } = await db.from('expense_categories').select('id, name').eq('tenant_id', tenantId);
        for (const x of (data ?? []) as any[]) nombreCat.set(String(x.id), String(x.name));
      } catch { /* sin nombres se agrupa igual */ }
      const porCat = new Map<string, number>();
      for (const g of filas) {
        const k = nombreCat.get(String(g.category_id)) ?? 'Sin categoría';
        porCat.set(k, (porCat.get(k) ?? 0) + Number(g.amount || 0));
      }
      const top = [...porCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      return ok(c, respuesta({
        respuesta: filas.length === 0
          ? `No hay gastos registrados ${etiqueta}.`
          : `${etiqueta.charAt(0).toUpperCase()}${etiqueta.slice(1)} gastaste ${money(total)} en ${filas.length} registro(s).`,
        detalle: top.map(([k, v]) => `${k}: ${money(v)}`).join(' · ') || null,
        fuente: `Gastos con fecha del ${desde} al ${hasta}.`,
      }));
    }

    if (esStock) {
      const { data } = await db.from('products')
        .select('name, stock_quantity, min_stock_level, tracks_stock')
        .eq('tenant_id', tenantId).is('deleted_at', null).limit(5000);
      const bajos = (data ?? []).filter((p: any) =>
        p.tracks_stock !== false && Number(p.stock_quantity ?? 0) <= Number(p.min_stock_level ?? 0));
      return ok(c, respuesta({
        respuesta: bajos.length === 0
          ? 'Ningún producto está por debajo de su mínimo.'
          : `Hay ${bajos.length} producto(s) en o por debajo del mínimo.`,
        detalle: bajos.slice(0, 8).map((p: any) => `${p.name}: ${p.stock_quantity} (mínimo ${p.min_stock_level})`).join(' · ') || null,
        fuente: 'Inventario actual contra el mínimo de cada producto.',
      }));
    }

    /**
     * No se reconoció la pregunta.
     *
     * En vez de recitar la lista entera de lo que sabe hacer, se busca el tema
     * MÁS CERCANO por palabras compartidas y se ofrece esa pregunta concreta.
     * «¿cuánto entró en caja?» no cae en ninguna regla, pero comparte «caja» y
     * «entró» con ventas: ofrecerle «¿Cuánto vendí este mes?» lo deja a un
     * toque de la respuesta, mientras que una lista de cinco temas lo deja
     * leyendo.
     */
    const TEMAS = [
      { pregunta: '¿Cuánto vendí este mes?',          claves: 'vender ventas facturar ingreso caja entro plata cuanto hice total' },
      { pregunta: '¿Qué producto me deja más plata?', claves: 'producto plato articulo vendido mejor top ranking deja gana' },
      { pregunta: '¿Quién me compra más?',            claves: 'cliente comprador quien compra frecuente fiel' },
      { pregunta: '¿Cuánto me deben?',                claves: 'deben cobrar pendiente credito deuda saldo moroso' },
      { pregunta: '¿Cuánto debo a proveedores?',      claves: 'pagar proveedor debo cuenta pagar' },
      { pregunta: '¿Cuánto gasté este mes?',          claves: 'gasto egreso salida compra pago servicio alquiler' },
      { pregunta: '¿Qué se está acabando?',           claves: 'stock existencia acabar agotar reponer minimo inventario falta' },
    ];
    const tokensPregunta = new Set(norm(texto).split(/[^a-z0-9ñ]+/).filter(w => w.length > 2));
    let mejorTema: { pregunta: string; n: number } | null = null;
    for (const t of TEMAS) {
      const n = t.claves.split(' ').filter(w => tokensPregunta.has(w)).length;
      if (n > 0 && (!mejorTema || n > mejorTema.n)) mejorTema = { pregunta: t.pregunta, n };
    }

    /**
     * Lo que las reglas no reconocen, se lo lleva el MODELO —si está encendido.
     *
     * Este es el único punto donde el chat gasta: las preguntas de siempre
     * («cuánto vendí», «qué se está acabando») las contesta la base, gratis y
     * con números exactos. Solo lo que nadie supo entender llega acá, con un
     * resumen chiquito del negocio como contexto.
     *
     * El contexto se mantiene CORTO a propósito. Mandarle el catálogo entero
     * en cada pregunta es lo que convierte centavos en dólares; si algún día
     * hiciera falta, va con caché de contexto del proveedor, no pegado al
     * mensaje.
     */
    if (modoIA() === 'real') {
      /* El crédito se toma ANTES de preguntar: si se tomara después, dos
         pestañas preguntando a la vez pasarían las dos el control. Si la
         consulta falla, se devuelve. */
      const credito = await tomarCredito(tenantId);
      if (!credito.ok) {
        return ok(c, respuesta({
          respuesta: credito.estado.incluidos <= 0
            ? 'Tu plan no incluye consultas al asistente inteligente. Lo que sí puedo contestarte con tus datos está acá abajo.'
            : `Se acabaron las ${credito.estado.incluidos} consultas al asistente de este mes. Se reinician el ${credito.estado.reinicia}.`,
          detalle: null,
          fuente: null,
          no_entendida: true,
          sin_creditos: true,
          creditos: credito.estado,
          sugerencias: TEMAS.slice(0, 4).map(t => t.pregunta),
        }));
      }
      const delModelo = await preguntarAlModelo(tenantId, texto, historial);
      if (!delModelo) await devolverCredito(tenantId);
      if (delModelo) {
        return ok(c, respuesta({
          respuesta: delModelo,
          detalle: null,
          fuente: `Respondido por ${proveedorIA() === 'gemini' ? 'Gemini Flash' : 'Claude'}`,
          no_entendida: false,
          creditos: credito.estado,
          sugerencias: [],
        }));
      }
    }

    /* Si el modelo está apagado se DICE. «Todavía no sé contestar eso» deja a
       quien pregunta creyendo que el sistema es tonto, cuando en realidad hay
       una variable de entorno sin poner y el dueño podría encenderla. */
    const apagada = modoIA() === 'demo';
    return ok(c, respuesta({
      respuesta: mejorTema
        ? `No estoy seguro de haber entendido. ¿Querías preguntar «${mejorTema.pregunta}»?`
        : apagada
          ? 'Eso no lo sé contestar con los datos de tu negocio, y el asistente inteligente está apagado. Lo que sí puedo contestarte está acá abajo.'
          : 'Todavía no sé contestar eso.',
      detalle: null,
      fuente: null,
      no_entendida: true,
      ia_apagada: apagada,
      // La pantalla las muestra como botones: así se contesta de un toque en
      // vez de tener que reescribir la pregunta.
      sugerencias: mejorTema
        ? [mejorTema.pregunta, ...TEMAS.filter(t => t.pregunta !== mejorTema!.pregunta).slice(0, 3).map(t => t.pregunta)]
        : TEMAS.map(t => t.pregunta),
    }));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// PASO 3 — DESCRIPCIONES PARA EL CATÁLOGO / MENÚ DIGITAL
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /descripciones  { ids?: string[], solo_vacias?: boolean }
 *
 * El catálogo digital que se publica con QR muestra nombre y precio, y poco
 * más: casi ningún producto tiene descripción, porque escribir doscientas a
 * mano no lo hace nadie. Esto las propone.
 *
 * En modo demostración se arman con lo que el producto YA tiene —categoría,
 * unidad, marca dentro del nombre— y nunca se inventa un dato que no esté:
 * una descripción que promete «hecho a mano con ingredientes frescos» sobre un
 * tornillo es peor que no tener ninguna, y el que la publica es el negocio.
 *
 * NUNCA se guardan solas: se devuelven como propuesta y la pantalla las aplica
 * si el dueño las acepta.
 */
ia.post('/descripciones', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
    const soloVacias = body?.solo_vacias !== false;

    let q = db.from('products')
      .select('id, name, description, unit_price, category_id, unit_type_id')
      .eq('tenant_id', tenantId).is('deleted_at', null).limit(300);
    if (ids.length > 0) q = q.in('id', ids);
    const { data: prods, error } = await q;
    if (error) throw new Error(error.message);

    const objetivo = (prods ?? []).filter((p: any) =>
      !soloVacias || !String(p.description ?? '').trim());
    if (objetivo.length === 0) return ok(c, respuesta({ propuestas: [] }));

    // Categorías y unidades, para poder decir algo que sea CIERTO.
    const cats = new Map<string, string>();
    const unid = new Map<string, string>();
    try {
      const { data } = await db.from('product_categories').select('id, name').eq('tenant_id', tenantId);
      for (const x of (data ?? []) as any[]) cats.set(String(x.id), String(x.name));
    } catch { /* sin categorías, la descripción sale más corta */ }
    try {
      const { data } = await db.from('unit_types').select('id, name').eq('tenant_id', tenantId);
      for (const x of (data ?? []) as any[]) unid.set(String(x.id), String(x.name));
    } catch { /* idem */ }

    /**
     * Arma la descripción SOLO con datos verificables del producto.
     *
     * El nombre suele traer la presentación («Coca Cola 2.5 L», «Arroz 1 kg»):
     * se reconoce y se dice aparte, que es lo que el cliente quiere saber.
     */
    const describir = (p: any): string => {
      const nombre = String(p.name ?? '').trim();
      const categoria = p.category_id ? cats.get(String(p.category_id)) : null;
      const unidad = p.unit_type_id ? unid.get(String(p.unit_type_id)) : null;
      const presentacion = nombre.match(/(\d+[.,]?\d*)\s*(ml|l|lt|litros?|kg|g|gr|gramos?|oz|un|uds?|unidades?)\b/i);
      const partes: string[] = [];
      if (categoria) partes.push(categoria);
      if (presentacion) partes.push(`presentación de ${presentacion[1]} ${presentacion[2].toLowerCase()}`);
      else if (unidad) partes.push(`se vende por ${unidad.toLowerCase()}`);
      if (partes.length === 0) return '';
      const limpio = partes.join(', ');
      return limpio.charAt(0).toUpperCase() + limpio.slice(1) + '.';
    };

    const propuestas = objetivo.map((p: any) => ({
      id: p.id, name: p.name,
      actual: String(p.description ?? '').trim() || null,
      propuesta: describir(p),
    })).filter(x => x.propuesta);

    return ok(c, respuesta({
      propuestas,
      sin_datos: objetivo.length - propuestas.length,
    }));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// CABYS ASISTIDO
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /cabys  { nombres: string[] }
 *
 * Ponerle código CABYS a un catálogo nuevo es el trabajo más odiado de montar
 * un negocio en facturación electrónica: son trece dígitos por producto,
 * elegidos de un catálogo de veinte mil filas, y equivocarse le cuesta al
 * negocio —no al sistema— frente a Hacienda.
 *
 * ── LA REGLA QUE NO SE NEGOCIA ────────────────────────────────────────────
 * El modelo NUNCA inventa un código. Se le dan los candidatos REALES que
 * salieron del catálogo oficial y de lo que otros negocios ya clasificaron, y
 * lo único que hace es ELEGIR entre ellos y explicar por qué. Un modelo de
 * lenguaje produce trece dígitos con total naturalidad y no hay forma de
 * distinguir a simple vista un código válido de uno inventado: para cuando
 * alguien se da cuenta, ya se facturó. Por eso la elección está acotada por
 * construcción y no por una instrucción en el prompt, que se puede ignorar.
 *
 * En modo demostración contesta igual, con el motivo que arma el buscador. La
 * diferencia con el modelo encendido es la calidad de la elección entre
 * candidatos, no que aparezcan códigos nuevos.
 */
ia.post('/cabys', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    /*
     * Cada producto puede venir como texto o como { nombre, contexto }.
     *
     * El contexto es el DEPARTAMENTO del archivo que se está importando
     * (LIMPIEZA, FERRETERÍA…). Se usa solo cuando el nombre por sí solo no
     * alcanza para decidir, y es lo que evita que «Guantes de latex» de un
     * negocio de limpieza terminen clasificados como repuesto de motocicleta.
     */
    const crudos: any[] = Array.isArray(body?.nombres) ? body.nombres : (body?.names ?? []);
    const items = crudos
      .map((x: any) => typeof x === 'string'
        ? { nombre: String(x ?? '').trim(), contexto: '' }
        : { nombre: String(x?.nombre ?? x?.name ?? '').trim(), contexto: String(x?.contexto ?? x?.categoria ?? '').trim() })
      .filter((x: any) => x.nombre);
    const nombres: string[] = items.map((x: any) => x.nombre);
    if (nombres.length === 0) return fail(c, 'Mandá al menos un nombre de producto', 422);
    if (nombres.length > 200) return fail(c, 'Máximo 200 productos por consulta', 422);

    /* Ocho alternativas, no tres: el modelo elige ENTRE LOS CANDIDATOS, así
       que la calidad del resultado está limitada por cuántos candidatos
       razonables le lleguen. La pantalla sigue mostrando las tres primeras
       —ocho botones por fila no se revisan—, pero el modelo las ve todas. */
    const base = await sugerirCabys(items, { alternativas: true, cuantas: 8, tenantId: c.get('tenantId') });

    /**
     * Los que quedaron flojos son los que valen la pena repasar.
     *
     * Con confianza alta el buscador ya acertó y gastar una llamada al modelo
     * ahí es tirar plata. El valor está en los dudosos y en los que quedaron
     * sin código, que son los que hoy terminan en un «0000000000000» o en una
     * tarde de alguien buscando a mano.
     */
    const dudosos = base.filter((x: any) => !x.code || x.confianza !== 'alta');

    let revisados = 0;
    /**
     * EL MODELO SE USA EN LA CARGA DE PRODUCTOS, PARA CUALQUIER NEGOCIO.
     *
     * Antes estaba reservado al dueño del sistema por el costo. El costo
     * sigue existiendo, pero poner mal un CAByS le cuesta al negocio frente a
     * Hacienda mucho más de lo que cuesta la consulta, y el momento de
     * ponerlo bien es cuando se carga el catálogo: después nadie vuelve a
     * revisar mil filas.
     *
     * Sigue acotado a la IMPORTACIÓN, que es donde hay cientos de productos
     * que clasificar de una vez. Un producto suelto lo resuelve el buscador
     * local, gratis y al instante.
     *
     * Lo que impide que esto sea una puerta abierta al modelo no es el
     * permiso: es que la respuesta está acotada a los candidatos que armamos
     * nosotros (ver la regla de abajo). Lo peor que puede salir de acá es un
     * CAByS real mal elegido, nunca uno inventado ni un texto cualquiera.
     */
    const origen = String(body?.origen ?? '').trim();
    const permiso = {
      motivo: `cabys:${origen || 'sin-origen'}`,
      autorizado: origen === 'importacion',
    };

    if (modoIA() === 'real' && permiso.autorizado && dudosos.length > 0) {
      /**
       * EN PARALELO Y CON TOPE.
       *
       * Una consulta al modelo tarda un segundo y pico. De a una, un lote con
       * treinta dudosos se pasa de los treinta segundos que aguanta la función
       * en Vercel y el importador recibe un error en vez de las sugerencias
       * que SÍ se resolvieron solas.
       *
       * De a diez a la vez, cien dudosos son unos doce segundos, que entra en
       * la ventana de la función. La pantalla manda de a cien nombres por
       * pedido, así que ese es el techo real de cada tanda.
       *
       * YA NO HAY TOPE DE CUÁNTOS SE REVISAN. Lo había —40 por lote— como
       * freno de mano para el gasto, y dejaba la mitad de un catálogo largo
       * sin repasar justo en la carga, que es la única vez que alguien mira
       * esas filas. Lo que frena el gasto ahora es la caché: el mismo producto
       * clasificado por otro negocio no se vuelve a preguntar.
       */
      const A_LA_VEZ = 10;
      const cola = dudosos;

      const revisarUno = async (item: any) => {
        /* El IVA viaja con cada candidato porque el código y su tarifa no se
           pueden separar: si el modelo elige otro código y se deja el IVA del
           anterior, el negocio termina cobrando un impuesto que no es el de
           lo que vende. */
        const candidatos = [
          ...(item.code ? [{ code: item.code, description: item.description, iva_rate: item.iva_rate }] : []),
          ...((item.alternativas ?? []) as any[]).map(a => ({ code: a.code, description: a.description, iva_rate: a.iva_rate })),
        ];
        if (candidatos.length < 2) return;
        const elegido = await pedirAlModelo({
          sistema: 'Sos un clasificador de productos para el catálogo CABYS de Costa Rica. '
            + 'Elegí el código que mejor describe el producto ENTRE LOS CANDIDATOS DADOS. '
            + 'Respondé solo con el código elegido y una razón de una línea, separados por «|». '
            + 'Si ninguno sirve, respondé «NINGUNO|» y la razón.',
          mensaje: `Producto: ${item.name}\nCandidatos:\n`
            + candidatos.map(x => `${x.code} — ${x.description}`).join('\n'),
          maxTokens: 120,
          permiso,
          /* GUARDADA UN MES Y MEDIO, Y COMPARTIDA ENTRE NEGOCIOS.
             «Coca-Cola 600 ml» con los mismos candidatos se clasifica igual
             hoy que en diciembre, y la van a importar veinte negocios. Sin
             ámbito a propósito: que el segundo negocio no pague lo que ya
             pagó el primero es justo lo que hace que esto sea barato. */
          cacheMin: 60 * 24 * 45,
        });
        if (!elegido) return;
        const [codigo, razon] = String(elegido).split('|').map(x => x.trim());
        // La defensa real: se acepta únicamente si el código está en la lista
        // que nosotros armamos. Si el modelo devolvió otra cosa, se ignora.
        const valido = candidatos.find(x => x.code === codigo);
        if (!valido) return;
        item.code = valido.code;
        item.description = valido.description;
        item.iva_rate = valido.iva_rate ?? null;
        item.fuente = 'ia';
        item.motivo = razon || item.motivo;
        revisados += 1;
      };

      for (let i = 0; i < cola.length; i += A_LA_VEZ) {
        await Promise.all(cola.slice(i, i + A_LA_VEZ).map(revisarUno));
      }
    }

    const conCodigo = base.filter((x: any) => x.code).length;
    return ok(c, respuesta({
      sugerencias: base,
      resumen: {
        total: base.length,
        con_codigo: conCodigo,
        sin_codigo: base.length - conCodigo,
        alta: base.filter((x: any) => x.confianza === 'alta').length,
        para_revisar: dudosos.length,
        revisados_por_el_modelo: revisados,
      },
      /* La pantalla tiene que poder decir QUIÉN contestó: con el modelo
         apagado las sugerencias son las del buscador local y se revisan
         distinto. Un «no pasó nada» silencioso se lee como que la IA falló. */
      modelo: {
        encendido: modoIA() === 'real',
        autorizado: permiso.autorizado,
        revisados,
      },
    }));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// TEXTOS PARA LOS ARTÍCULOS DE LA PÁGINA PÚBLICA
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /landing-articulo  { nombre, precio?, publico? }
 *
 * Escribir la ficha de un plan a mano es lo que hace que la página quede a
 * medio llenar: hay que acordarse de TODO lo que incluye, y lo que incluye
 * cambia cada vez que se toca un plan.
 *
 * ── De dónde sale el texto, y por qué eso importa ─────────────────────────
 * De los PLANES REALES del sistema. Se busca el plan por nombre y se listan
 * sus módulos activos con las mismas etiquetas que ya usan los correos
 * (`planFeatureLabels`). O sea: lo que la página promete es exactamente lo
 * que el plan entrega.
 *
 * Un modelo de lenguaje escribiendo esto libremente produciría una lista
 * preciosa con dos funciones que no existen, y eso en una página de precios
 * no es un detalle: es prometerle a un cliente algo que no va a recibir. Por
 * eso los puntos salen de la base y el modelo —cuando se encienda— solo
 * puede redactar la frase de presentación.
 */
ia.post('/landing-articulo', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const nombre = String(body?.nombre ?? '').trim();
    if (!nombre) return fail(c, 'Escribí primero el nombre del plan', 422);

    const { data: planes } = await db.from('subscription_plans')
      .select('name, description, price, features, is_active');

    /**
     * El plan que corresponde, buscándolo con tolerancia.
     *
     * Quien escribe «Básico» en la página se refiere al plan «basico fe con
     * inventario»: exigir el nombre exacto convertiría la ayuda en un «no
     * encontré nada» casi siempre. Se descartan los planes «Demo · <negocio>»,
     * que son de un cliente concreto y no se venden.
     */
    const limpio = (x: any) => norm(String(x ?? ''));
    const n = limpio(nombre);
    const candidatos = ((planes ?? []) as any[])
      .filter(p => !/^demo\s*·/i.test(String(p.name ?? '')));
    const plan = candidatos.find(p => limpio(p.name) === n)
      ?? candidatos.find(p => limpio(p.name).includes(n) || n.includes(limpio(p.name)))
      ?? null;

    if (!plan) {
      return ok(c, respuesta({
        encontrado: false,
        nombres_disponibles: candidatos.map(p => p.name).slice(0, 12),
        aviso_vacio: `No hay ningún plan que se parezca a «${nombre}». Escribí el nombre como está `
          + 'en Planes y volvé a intentar, o llená la ficha a mano.',
      }));
    }

    const incluye = planFeatureLabels(plan.features);
    const precio = Number(plan.price ?? 0);

    /**
     * La frase de presentación.
     *
     * En modo demostración se arma con lo que el plan TIENE, no con adjetivos:
     * «Punto de venta, inventario y facturación electrónica para un negocio
     * con una sucursal». Es menos vistoso que lo que escribiría un modelo y
     * tiene una ventaja que lo compensa: todo lo que dice es verificable.
     */
    const f: any = plan.features ?? {};
    const partes: string[] = [];
    if (f.pos) partes.push('punto de venta');
    if (f.inventory) partes.push('inventario');
    if (f.electronic_invoicing) partes.push('facturación electrónica a Hacienda');
    if (f.reports) partes.push('reportes');
    const cola = f.multi_branch ? 'con varias sucursales'
      : f.hr ? 'con planilla'
      : 'de una sola sucursal';
    const descripcion = partes.length
      ? `${partes.slice(0, -1).join(', ')}${partes.length > 1 ? ' y ' : ''}${partes[partes.length - 1]}`
        .replace(/^./, ch => ch.toUpperCase()) + ` para un negocio ${cola}.`
      : String(plan.description ?? '').trim();

    // Con el modelo encendido se mejora SOLO la redacción. Los puntos de
    // `incluye` nunca pasan por él: son datos, no estilo.
    let descripcionFinal = descripcion;
    if (modoIA() === 'real') {
      const r = await pedirAlModelo({
        sistema: 'Escribís para la página de precios de un sistema de punto de venta en Costa Rica. '
          + 'Reescribí la descripción en UNA frase, en español de Costa Rica, clara y sin adjetivos '
          + 'publicitarios. NO agregues ninguna función que no esté en la lista.',
        mensaje: `Plan: ${plan.name}\nIncluye: ${incluye.join(', ')}\nBorrador: ${descripcion}`,
        maxTokens: 120,
      });
      if (r && r.trim()) descripcionFinal = r.trim();
    }

    return ok(c, respuesta({
      encontrado: true,
      plan: plan.name,
      descripcion: descripcionFinal,
      incluye,
      precio_sugerido: precio > 0
        ? `₡${precio.toLocaleString('es-CR')}/mes`
        : '',
      fuente: `Tomado del plan «${plan.name}» tal como está configurado hoy: `
        + `${incluye.length} módulo(s) activos.`,
    }));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// PASO 5 — SOPORTE: EXPLICAR UN DIAGNÓSTICO EN CRISTIANO
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /explicar-diagnostico  { pasos: [{ nombre, ok, detalle }], contexto? }
 *
 * El diagnóstico de impresión devuelve pasos técnicos. Quien los lee es el
 * cajero, no un técnico: «el puerto 8181 no responde» no le dice qué hacer.
 * Esto lo traduce a una instrucción, en orden, y dice qué NO es el problema —
 * que es lo que evita que alguien pase la tarde detrás del certificado cuando
 * lo que falta es un permiso del navegador.
 */
ia.post('/explicar-diagnostico', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const pasos: Array<{ nombre: string; ok: boolean; detalle?: string }> =
      Array.isArray(body?.pasos) ? body.pasos : [];
    if (pasos.length === 0) return fail(c, 'No hay diagnóstico que explicar', 422);

    const fallaron = pasos.filter(x => !x.ok);
    const texto = (x: any) => `${x.nombre} ${x.detalle ?? ''}`.toLowerCase();

    const reglas: Array<{ busca: RegExp; titulo: string; hacer: string[] }> = [
      {
        busca: /red local|lna|permiso/,
        titulo: 'Chrome está bloqueando el acceso a la red local',
        hacer: [
          'Tocá el candado de la barra de direcciones (o el ⋮ si usás la app instalada).',
          'Entrá a «Configuración del sitio».',
          'Buscá «Dispositivos de la red local» (en inglés, «Apps on this device») y ponelo en Permitir.',
          'Recargá la página y volvé a intentar imprimir.',
        ],
      },
      {
        /**
         * Va ANTES que las demás: cuando aparece este texto, todo lo otro ya
         * pasó y la causa es inequívoca.
         *
         * El orden de los pasos salió de un caso real. Primero se mandaba a
         * probar en incógnito, por las extensiones; el cliente probó y falló
         * igual. Y tiene sentido: el antivirus con filtro web y las políticas
         * del navegador SIGUEN ACTIVOS en incógnito, así que incógnito no
         * descarta nada por sí solo. Ahora primero va la prueba que sí separa
         * las causas —otro navegador—, y lo del incógnito queda al final, que
         * es lo que de verdad aporta.
         */
        busca: /blocked by client|err_blocked|blocked_by/i,
        titulo: 'QZ Tray tiene este sitio en su lista de bloqueados',
        hacer: [
          'Clic derecho en el icono de QZ Tray, junto al reloj → Advanced → Site Manager.',
          'Pestaña «Blocked»: borrá TODO lo que haya ahí con «Delete». No busques «colonclick.com»: QZ guarda certificados, no dominios, y sin certificado la entrada figura como «Untrusted» o «Unsigned» — por eso el bloqueo afecta a Chrome, Edge y Firefox por igual.',
          'En Advanced, desmarcá «Block anonymous requests» si está marcada (sin certificado, nuestras peticiones son anónimas y esa opción las rechaza).',
          'Volvé a tocar «Conectar QZ Tray» y elegí «Allow», marcando «Remember».',
          'Si la lista «Blocked» está vacía y sigue igual: cerrá QZ Tray, borrá la carpeta %APPDATA%\\qz y volvé a abrirlo.',
        ],
      },
      {
        // El navegador cortando el WebSocket es OTRA cosa, y se reconoce solo
        // por el paso del canal de datos. Separarlas importa: el arreglo de una
        // está dentro de QZ Tray y el de la otra en el navegador o el antivirus,
        // y confundirlas fue lo que hizo perder un día de soporte.
        busca: /websocket|canal de datos/i,
        titulo: 'Algo entre el navegador y QZ está cortando la conexión',
        hacer: [
          'Abrí la página en OTRO navegador (Firefox o Edge). Si ahí imprime, el problema es de Chrome; si tampoco, es algo instalado en la computadora.',
          'Antivirus: desactivá un rato la «protección web» o el «filtrado SSL» (Kaspersky, ESET, Avast, Bitdefender cortan este tipo de conexión).',
          'Si la computadora la administra una empresa: abrí chrome://policy y buscá «URLBlocklist»; una regla con ws:// o wss:// lo bloquea todo.',
          'Recién al final, incógnito (Ctrl+Mayús+N): solo descarta extensiones, no el antivirus ni las políticas.',
          'Mientras tanto se puede cobrar con «Imprimir por el navegador», que no usa QZ.',
        ],
      },
      {
        busca: /escuchando|no responde|8181|8282/,
        titulo: 'La impresora no está contestando en esta computadora',
        hacer: [
          'Revisá que QZ Tray esté abierto: tiene que estar el icono junto al reloj.',
          'Si no está, abrilo desde el menú de inicio y esperá unos segundos.',
          'Volvé a correr el diagnóstico.',
        ],
      },
      {
        busca: /llave|certificado|firma/,
        titulo: 'La firma quedó a medias',
        hacer: [
          'Usá el botón «Usar modo comunidad» de esta misma pantalla.',
          'Con los dos campos vacíos, la impresora pide permiso una vez y queda andando.',
          'No hace falta comprar ningún certificado para imprimir.',
        ],
      },
      {
        busca: /app instalada|pwa/,
        titulo: 'Estás en la app instalada',
        hacer: [
          'Abrí el sistema en Chrome normal, una sola vez.',
          'Aceptá ahí los permisos que pida.',
          'Volvé a la app: el permiso queda guardado para el sitio.',
        ],
      },
    ];

    const encontradas = reglas.filter(r => fallaron.some(x => r.busca.test(texto(x))));
    const descartado = pasos.filter(x => x.ok).map(x => x.nombre);

    return ok(c, respuesta({
      resumen: fallaron.length === 0
        ? 'Todo pasó: la impresión está lista para usarse.'
        : `Falló ${fallaron.length} de ${pasos.length} revisiones. Empezá por lo primero de la lista.`,
      // Sin `busca`: la regex es de uso interno y no tiene nada que hacer
      // viajando hasta la pantalla del cajero.
      acciones: encontradas.length > 0 ? encontradas.map(({ titulo, hacer }) => ({ titulo, hacer })) : (fallaron.length > 0 ? [{
        titulo: fallaron[0].nombre,
        hacer: [fallaron[0].detalle || 'Volvé a correr el diagnóstico y mandanos el resultado.'],
      }] : []),
      ya_descartado: descartado,
    }));
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default ia;
