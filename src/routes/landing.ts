import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * LA PÁGINA PÚBLICA de ColónClick: lo que ve alguien que todavía no es cliente.
 *
 * Dos routers en un archivo, a propósito, porque son dos caras de lo mismo:
 *   · `landingPublic` — SIN sesión. Lo abre cualquiera desde internet.
 *   · `landingAdmin`  — con sesión de administrador. Lo edita el dueño.
 *
 * Todo lo que sale por el router público está pensado desde la pregunta «¿qué
 * pasa si esto lo llama un robot diez mil veces?». Es la única parte del
 * sistema a la que le puede escribir un desconocido.
 */

export const landingPublic = new Hono();
export const landingAdmin = new Hono<{ Variables: { userId: string } }>();

const CLAVE = 'default';

/**
 * El contenido de arranque.
 *
 * La página tiene que verse completa ANTES de que alguien la edite: si saliera
 * vacía hasta que el dueño la llene, el día del cambio de ruteo los visitantes
 * se encuentran con una página en blanco. Esto es lo que se ve mientras tanto,
 * y es también el ejemplo de qué se puede escribir en cada campo.
 */
const POR_OMISION = {
  marca: 'ColónClick',
  titulo: 'El punto de venta y la facturación electrónica de tu negocio',
  bajada: 'Facturá a Hacienda, controlá tu inventario y mirá tus números desde el celular. '
    + 'Hecho en Costa Rica, para negocios de Costa Rica.',
  cta_texto: 'Pedir una demostración',
  /** Imagen grande de arriba. Vacío = no se muestra ninguna. */
  imagen: '',
  /**
   * Logos de clientes a mostrar. VACÍO POR OMISIÓN, a propósito.
   *
   * Publicar la marca de un cliente en internet es decisión del cliente, no
   * nuestra. El panel muestra los logos disponibles y el administrador elige
   * cuáles —presumiblemente después de preguntarles—. Llenar esto solo con
   * todos los logos del sistema sería publicar la cartera de clientes entera
   * sin que nadie lo decidiera.
   */
  clientes: [] as Array<{ nombre: string; logo: string }>,
  clientes_titulo: 'Negocios que ya facturan con ColónClick',
  beneficios: [
    { titulo: 'Facturación electrónica', detalle: 'Conectado a Hacienda. Facturas, tiquetes y notas de crédito sin trámites aparte.' },
    { titulo: 'Inventario al día', detalle: 'Entradas, salidas y mínimos. Sabés qué se está acabando antes de que falte.' },
    { titulo: 'Funciona sin internet', detalle: 'Si se cae la conexión, seguís cobrando. Cuando vuelve, se sincroniza solo.' },
  ],
  /**
   * LOS PLANES. Cada uno con su precio mensual y, si lo hay, el anual.
   *
   * El anual es opcional: un plan sin él simplemente no aparece cuando el
   * visitante mira la vista anual, en vez de mostrar el precio mensual con
   * otra etiqueta —que sería mentirle—.
   */
  productos: [] as Array<{
    nombre: string; precio: string; precio_anual?: string; ahorro?: string;
    descripcion: string; incluye: string[]; destacado?: boolean; imagen?: string;
  }>,
  /**
   * EL CATÁLOGO: lo que se vende suelto, fuera de los planes.
   *
   * Un rotulador, una gaveta, la puesta en marcha, un módulo aparte. Va en su
   * propia sección porque mezclar un accesorio de ₡30.000 entre los planes
   * mensuales confunde la decisión principal, que es elegir plan.
   */
  catalogo_titulo: 'Catálogo',
  catalogo_bajada: 'Equipo y servicios que se compran una vez.',
  catalogo: [] as Array<{ nombre: string; precio: string; descripcion: string; imagen?: string }>,
  contacto: { telefono: '', correo: '', whatsapp: '' },
  pie: 'ColónClick · Costa Rica',
};

/**
 * La fila de contenido, distinguiendo «no hay nada guardado» de «la tabla no
 * existe».
 *
 * No es lo mismo y la pantalla necesita saberlo: sin la migración corrida, el
 * editor dejaba escribir un rato largo y recién fallaba al guardar, con el
 * texto perdido. Mejor avisar antes de que alguien escriba.
 */
async function fila(): Promise<{ datos: any | null; sinTabla: boolean }> {
  const { data, error } = await db.from('landing_content').select('*').eq('key', CLAVE).maybeSingle();
  if (error) return { datos: null, sinTabla: /landing_content/.test(error.message) };
  return { datos: (data as any) ?? null, sinTabla: false };
}

// ══════════════════════════════════════════════════════════════════════════
// PÚBLICO
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /  — lo que se muestra en la página.
 *
 * Devuelve SIEMPRE algo mostrable: si la tabla no existe todavía (migración
 * sin correr) o nadie publicó nada, salen los textos de arranque. Una página
 * de presentación que responde un error es peor que una genérica, porque el
 * visitante no vuelve.
 */
landingPublic.get('/', async (c) => {
  try {
    const { datos: f } = await fila();
    const pub = f?.published ?? null;
    return ok(c, {
      contenido: { ...POR_OMISION, ...(pub ?? {}) },
      publicado_en: f?.published_at ?? null,
      /** false = nunca se publicó: lo que se ve son los textos de fábrica. */
      personalizado: !!pub,
    });
  } catch {
    return ok(c, { contenido: POR_OMISION, publicado_en: null, personalizado: false });
  }
});

/**
 * Límite por IP para lo que escribe un desconocido.
 *
 * Un formulario público sin freno se llena de basura en una semana, y después
 * nadie distingue un interesado de verdad entre doscientos envíos de robot.
 * Se lleva en memoria a propósito: es una defensa de primera línea, barata, y
 * si el servidor se reinicia no pasa nada grave.
 */
const golpes = new Map<string, number[]>();
const LIMITE = 3;                    // envíos
const VENTANA = 60 * 60_000;         // por hora

function demasiados(ip: string): boolean {
  const ahora = Date.now();
  const previos = (golpes.get(ip) ?? []).filter(t => ahora - t < VENTANA);
  previos.push(ahora);
  golpes.set(ip, previos);
  if (golpes.size > 5000) golpes.clear();   // no crecer sin techo
  return previos.length > LIMITE;
}

const ipDe = (c: any): string =>
  String(c.req.header('x-forwarded-for') ?? '').split(',')[0].trim()
  || c.req.header('x-real-ip') || 'desconocida';

/** Suma uno al contador del día. Nunca debe hacer fallar lo que la llamó. */
async function contar(evento: string, origen = '') {
  try {
    const dia = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
    const limpio = String(origen).replace(/^https?:\/\//, '').split('/')[0].slice(0, 80);
    const { data } = await db.from('landing_stats')
      .select('cuenta').eq('dia', dia).eq('evento', evento).eq('origen', limpio).maybeSingle();
    await db.from('landing_stats').upsert(
      { dia, evento, origen: limpio, cuenta: Number((data as any)?.cuenta ?? 0) + 1 },
      { onConflict: 'dia,evento,origen' },
    );
  } catch { /* la medición jamás puede costar una visita */ }
}

/** POST /visita  { evento?, origen? } — el contador de la fase 5. */
landingPublic.post('/visita', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const evento = ['visita', 'formulario', 'clic_entrar'].includes(String(body?.evento))
    ? String(body.evento) : 'visita';
  await contar(evento, String(body?.origen ?? ''));
  return ok(c, { ok: true });
});

/**
 * POST /interesado — el formulario de la página.
 *
 * Escribe en `landing_leads`, su propia tabla. La primera intención fue reusar
 * `demo_requests`, que ya tiene solicitudes reales, y estaba mal: esa tabla
 * exige un negocio y su bandeja filtra por negocio, así que un interesado de
 * la calle habría entrado sin aparecer en ninguna pantalla. Un formulario cuyo
 * resultado nadie ve es peor que no tenerlo.
 *
 * De paso resuelve algo más: la única tabla a la que le puede escribir un
 * desconocido no contiene datos de ningún cliente.
 */
landingPublic.post('/interesado', async (c) => {
  try {
    const ip = ipDe(c);
    if (demasiados(ip)) {
      return fail(c, 'Recibimos varias solicitudes desde esta conexión. Probá de nuevo en un rato '
        + 'o escribinos directamente por WhatsApp.', 429);
    }
    const b = await c.req.json().catch(() => ({}));

    /**
     * Campo trampa.
     *
     * Se llama como un campo cualquiera y está escondido: una persona nunca lo
     * ve, un robot que rellena todo sí lo completa. Cuesta tres líneas y filtra
     * la mayor parte del ruido sin ponerle un captcha enfrente a un cliente de
     * verdad, que es lo que hace que algunos se vayan.
     */
    if (String(b?.empresa_web ?? '').trim()) return ok(c, { ok: true });   // silencio: que el robot crea que entró

    const nombre = String(b?.contact_name ?? '').trim();
    const telefono = String(b?.phone ?? '').trim();
    if (!nombre) return fail(c, 'Escribí tu nombre', 422);
    if (!telefono && !String(b?.email ?? '').trim()) {
      return fail(c, 'Dejanos un teléfono o un correo para poder contestarte', 422);
    }

    // Todo recortado: lo que escribe un desconocido entra con tope de largo,
    // o un envío con un texto de un megabyte queda guardado para siempre.
    const { error } = await db.from('landing_leads').insert({
      business_name: String(b?.business_name ?? '').trim().slice(0, 120) || null,
      contact_name: nombre.slice(0, 120),
      phone: telefono.slice(0, 40) || null,
      email: String(b?.email ?? '').trim().slice(0, 160) || null,
      business_type: String(b?.business_type ?? '').trim().slice(0, 80) || null,
      notes: String(b?.notes ?? '').trim().slice(0, 1000) || null,
      origen: String(b?.origen ?? '').replace(/^https?:\/\//, '').split('/')[0].slice(0, 120) || null,
      status: 'nuevo',
    });
    if (error) throw new Error(error.message);
    await contar('formulario', String(b?.origen ?? ''));
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMINISTRACIÓN
// ══════════════════════════════════════════════════════════════════════════

landingAdmin.get('/', async (c) => {
  try {
    const { datos: f, sinTabla } = await fila();
    return ok(c, {
      sin_tabla: sinTabla,
      borrador: { ...POR_OMISION, ...((f?.draft ?? {}) as any) },
      publicado: f?.published ?? null,
      publicado_en: f?.published_at ?? null,
      /** true = hay cambios sin publicar. */
      sin_publicar: JSON.stringify(f?.draft ?? {}) !== JSON.stringify(f?.published ?? {}),
      por_omision: POR_OMISION,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

landingAdmin.put('/', async (c) => {
  try {
    const borrador = await c.req.json().catch(() => null);
    if (!borrador || typeof borrador !== 'object') return fail(c, 'Contenido inválido', 422);
    const { error } = await db.from('landing_content').upsert(
      { key: CLAVE, draft: borrador, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
    if (error) throw new Error(error.message);
    return ok(c, { guardado: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** POST /publicar — pasa el borrador a la página pública. Es el único momento
 *  en que un cambio se vuelve visible para un desconocido. */
landingAdmin.post('/publicar', async (c) => {
  try {
    const { datos: f } = await fila();
    const borrador = (f?.draft ?? {}) as any;
    const { error } = await db.from('landing_content').upsert(
      { key: CLAVE, draft: borrador, published: borrador, published_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
    if (error) throw new Error(error.message);
    return ok(c, { publicado: true, en: new Date().toISOString() });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * POST /imagen  { content_base64, content_type, uso }
 *
 * Las imágenes de la página las sube EL SERVIDOR, no el navegador.
 *
 * Es el mismo camino que el logo del negocio (routes/sharedDocs.ts), y por el
 * mismo motivo: subir directo desde el navegador depende de que el bucket
 * exista y de que sus permisos dejen escribir ahí, y cuando algo falta el
 * error que ve la persona es «new row violates row-level security policy»,
 * que no le dice nada a nadie. El servidor puede crear el bucket y escribir
 * siempre.
 */
const BUCKET_LANDING = 'logos';          // público; el mismo del logo
const MAX_IMAGEN = 4 * 1024 * 1024;

landingAdmin.post('/imagen', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({} as any));
    const b64 = String(body?.content_base64 ?? '');
    const tipo = String(body?.content_type ?? 'image/jpeg');
    // `uso` da el nombre del archivo: 'portada' o 'producto-2'. Un nombre fijo
    // por uso evita que cada cambio deje la imagen anterior ocupando lugar
    // para siempre.
    const uso = String(body?.uso ?? 'imagen').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'imagen';
    if (!b64) return fail(c, 'Falta la imagen', 422);
    if (!/^image\//.test(tipo)) return fail(c, 'El archivo tiene que ser una imagen', 422);

    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length) return fail(c, 'La imagen llegó vacía', 422);
    if (bytes.length > MAX_IMAGEN) return fail(c, 'La imagen es muy grande (máximo 4 MB)', 413);

    try { await db.storage.createBucket(BUCKET_LANDING, { public: true }); } catch { /* ya existe */ }

    const ext = tipo.includes('png') ? 'png' : tipo.includes('webp') ? 'webp' : 'jpg';
    const path = `landing/${uso}.${ext}`;
    const { error: upErr } = await db.storage.from(BUCKET_LANDING)
      .upload(path, bytes, { contentType: tipo, upsert: true, cacheControl: '3600' });
    if (upErr) throw new Error(upErr.message);

    const { data } = db.storage.from(BUCKET_LANDING).getPublicUrl(path);
    // El sufijo de tiempo obliga a recargar: sin él se sigue viendo la imagen
    // vieja, que quedó en la caché del navegador con el mismo nombre.
    return ok(c, { url: `${data.publicUrl}?t=${Date.now()}` });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * GET /logos — los logos de clientes que EXISTEN, para poder elegir.
 *
 * Solo lista. No publica nada: lo que se muestra en la página es lo que
 * quede guardado en `clientes`, y eso lo arma el administrador a mano.
 */
landingAdmin.get('/logos', async (c) => {
  try {
    const { data: carpetas } = await db.storage.from(BUCKET_LANDING).list('', { limit: 200 });
    const { data: tenants } = await db.from('tenants').select('id, name, is_demo');
    const info = new Map(((tenants ?? []) as any[]).map(t => [t.id, t]));

    const salida: any[] = [];
    for (const car of ((carpetas ?? []) as any[])) {
      if (car.id) continue;                       // es un archivo suelto, no una carpeta
      const t = info.get(car.name);
      if (!t || t.is_demo) continue;              // carpeta sin negocio, o un demo
      const { data: archivos } = await db.storage.from(BUCKET_LANDING).list(car.name, { limit: 10 });
      // Solo el logo propiamente dicho: en esa carpeta también caen imágenes
      // del menú digital, que no son la marca del negocio.
      const logo = ((archivos ?? []) as any[]).find(a => a.id && /^logo\./i.test(a.name));
      if (!logo) continue;
      const { data } = db.storage.from(BUCKET_LANDING).getPublicUrl(`${car.name}/${logo.name}`);
      salida.push({ tenant_id: car.name, nombre: t.name, logo: data.publicUrl });
    }
    return ok(c, { logos: salida.sort((a, b) => a.nombre.localeCompare(b.nombre)) });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** GET /interesados — la bandeja. Sin esto el formulario no sirve de nada. */
landingAdmin.get('/interesados', async (c) => {
  try {
    const estado = c.req.query('estado');
    let q = db.from('landing_leads').select('*').order('created_at', { ascending: false }).limit(300);
    if (estado) q = q.eq('status', estado);
    const { data, error } = await q;
    if (error) {
      if (/landing_leads/.test(error.message)) return ok(c, { sin_tabla: true, interesados: [] });
      throw new Error(error.message);
    }
    return ok(c, { interesados: data ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** PUT /interesados/:id — mover de estado (contactado, convertido, descartado). */
landingAdmin.put('/interesados/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const b = await c.req.json().catch(() => ({}));
    const estados = ['nuevo', 'contactado', 'convertido', 'descartado'];
    const parche: any = { updated_at: new Date().toISOString() };
    if (b?.status && estados.includes(String(b.status))) parche.status = String(b.status);
    if (typeof b?.notes === 'string') parche.notes = b.notes.slice(0, 2000);
    const { error } = await db.from('landing_leads').update(parche).eq('id', id);
    if (error) throw new Error(error.message);
    return ok(c, { actualizado: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * GET /estadisticas?dias=30 — la fase 5.
 *
 * Tres números y de dónde vienen las visitas. La conversión es el único que
 * de verdad decide si la página sirve: mil visitas sin un solo formulario
 * significan que la página no convence, no que haga falta más tráfico.
 */
landingAdmin.get('/estadisticas', async (c) => {
  try {
    const dias = Math.min(365, Math.max(1, Number(c.req.query('dias') ?? 30)));
    const desde = new Date(Date.now() - dias * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
    const { data, error } = await db.from('landing_stats').select('*').gte('dia', desde).order('dia', { ascending: true });
    if (error) {
      if (/landing_stats/.test(error.message)) return ok(c, { sin_tabla: true, dias, totales: {}, por_dia: [], origenes: [] });
      throw new Error(error.message);
    }
    const filas = (data ?? []) as any[];
    const totales: Record<string, number> = {};
    const porDia = new Map<string, any>();
    const origenes = new Map<string, number>();
    for (const f of filas) {
      totales[f.evento] = (totales[f.evento] ?? 0) + Number(f.cuenta ?? 0);
      const d = porDia.get(f.dia) ?? { dia: f.dia, visita: 0, formulario: 0, clic_entrar: 0 };
      d[f.evento] = (d[f.evento] ?? 0) + Number(f.cuenta ?? 0);
      porDia.set(f.dia, d);
      if (f.evento === 'visita' && f.origen) {
        origenes.set(f.origen, (origenes.get(f.origen) ?? 0) + Number(f.cuenta ?? 0));
      }
    }
    const visitas = totales.visita ?? 0;
    return ok(c, {
      dias, totales,
      // De cada cien que entran, cuántos escriben.
      conversion: visitas > 0 ? Math.round(((totales.formulario ?? 0) / visitas) * 1000) / 10 : null,
      por_dia: [...porDia.values()],
      origenes: [...origenes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([origen, n]) => ({ origen: origen || 'directo', visitas: n })),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default landingPublic;
