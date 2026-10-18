import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { businessContact, enviarAnuncio } from '../services/whatsappNotify.js';
import { recomendacionesPara } from '../services/recomendacionesUso.js';

/**
 * ANUNCIOS: contarle a los clientes que salió algo nuevo.
 *
 * Un módulo que nadie sabe que existe es trabajo tirado. Esto manda un
 * mensaje por WhatsApp a los negocios, eligiendo a cuáles por plan y por
 * estado.
 *
 * ── Las tres reglas que lo hacen seguro ───────────────────────────────────
 * 1. NUNCA se manda sin ver antes la lista exacta de destinatarios. Esto le
 *    escribe a clientes reales: un error no se puede deshacer.
 * 2. Se guarda a quién se le mandó. Repetir el mismo anuncio al mismo número
 *    es la forma más rápida de que bloqueen la cuenta, y ahí se cae también
 *    el canal de los recordatorios de pago y los comprobantes.
 * 3. Hay envío de PRUEBA a un solo número antes de la tanda.
 */
export const anuncios = new Hono<{ Variables: { userId: string } }>();

type Estado = 'al_dia' | 'moroso' | 'inactivo';
const DIAS_INACTIVO = 60;

/**
 * Los negocios, con su plan, su estado y su teléfono.
 *
 * El teléfono sale de `businessContact`, que ya sabe buscarlo en los cinco
 * lugares donde puede estar guardado. Reusarlo no es por ahorrar líneas: es
 * para que el anuncio llegue a los mismos números a los que ya llegan los
 * recordatorios, y no a un subconjunto distinto.
 */
async function destinatarios() {
  const hoyCR = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
  const [{ data: tenants }, { data: subs }, { data: planes }] = await Promise.all([
    db.from('tenants').select('id, name, status, is_demo'),
    db.from('subscriptions').select('tenant_id, plan_id, ends_at').eq('status', 'active'),
    db.from('subscription_plans').select('id, name, features'),
  ]);
  const info = new Map(((tenants ?? []) as any[]).map(t => [t.id, t]));
  const plan = new Map(((planes ?? []) as any[]).map(p => [p.id, p]));

  // Última factura por negocio: la señal de si el sistema se está usando.
  const ultima = new Map<string, string>();
  for (let d = 0; ; d += 1000) {
    const { data, error } = await db.from('invoices')
      .select('tenant_id, issued_at').order('id', { ascending: true }).range(d, d + 999);
    if (error) break;
    const filas = (data ?? []) as any[];
    for (const f of filas) {
      const p = ultima.get(f.tenant_id);
      if (!p || String(f.issued_at) > p) ultima.set(f.tenant_id, String(f.issued_at));
    }
    if (filas.length < 1000) break;
  }

  const candidatos = ((subs ?? []) as any[])
    .filter(s => { const t = info.get(s.tenant_id); return t && !t.is_demo; });

  /**
   * Los teléfonos se buscan EN PARALELO.
   *
   * `businessContact` mira hasta cinco lugares distintos por negocio. Uno por
   * uno, cuarenta negocios eran la mitad del tiempo de esta pantalla, y son
   * búsquedas que no dependen entre sí.
   */
  const contactos = await Promise.all(
    candidatos.map(s => businessContact(s.tenant_id).catch(() => ({ phone: '', name: '' }))),
  );

  return candidatos.map((s, i) => {
    const t = info.get(s.tenant_id);
    const pl = plan.get(s.plan_id);
    const ult = ultima.get(s.tenant_id);
    const dias = ult ? Math.floor((Date.now() - new Date(ult).getTime()) / 86_400_000) : null;
    const estado: Estado =
      (t.status === 'suspended' || (s.ends_at && String(s.ends_at).slice(0, 10) < hoyCR)) ? 'moroso'
      : (dias === null || dias > DIAS_INACTIVO) ? 'inactivo'
      : 'al_dia';
    return {
      tenant_id: s.tenant_id,
      negocio: t.name,
      plan_id: s.plan_id,
      plan: pl?.name ?? '—',
      features: pl?.features ?? {},
      estado,
      dias_sin_facturar: dias,
      telefono: contactos[i].phone || null,
    };
  });
}

/**
 * Caché corta de las recomendaciones.
 *
 * Son cientos de consultas y el dato cambia de un día para otro, no de un
 * minuto para otro. Sin esto, abrir la pestaña tres veces seguidas repetía
 * todo el trabajo.
 */
let cacheRecs: { en: number; datos: any } | null = null;
const RECS_TTL = 15 * 60_000;

/**
 * GET /destinatarios?planes=id,id&estados=al_dia,moroso
 *
 * La lista exacta de a quién le llegaría. Se mira ANTES de mandar nada.
 */
anuncios.get('/destinatarios', async (c) => {
  try {
    const planes = String(c.req.query('planes') ?? '').split(',').filter(Boolean);
    const estados = String(c.req.query('estados') ?? '').split(',').filter(Boolean) as Estado[];
    const todos = await destinatarios();
    const filtrados = todos.filter(d =>
      (planes.length === 0 || planes.includes(d.plan_id))
      && (estados.length === 0 || estados.includes(d.estado)));

    // Agrupado por plan, para poder elegir con criterio.
    const porPlan = new Map<string, any>();
    for (const d of todos) {
      const a = porPlan.get(d.plan_id) ?? { plan_id: d.plan_id, plan: d.plan, total: 0, con_telefono: 0, al_dia: 0, moroso: 0, inactivo: 0 };
      a.total += 1;
      if (d.telefono) a.con_telefono += 1;
      a[d.estado] += 1;
      porPlan.set(d.plan_id, a);
    }

    return ok(c, {
      destinatarios: filtrados,
      /** Los que se quedarían sin recibirlo por no tener teléfono guardado. */
      sin_telefono: filtrados.filter(d => !d.telefono).length,
      alcanzables: filtrados.filter(d => d.telefono).length,
      planes: [...porPlan.values()].sort((a, b) => b.total - a.total),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * GET /recomendaciones?tenant_id=…
 *
 * Qué módulos tiene en el plan y no está usando. Sirve para dos cosas: para
 * escribir un anuncio que le hable de algo que le falta, y para saber con
 * quién conviene hablar antes de que se dé de baja.
 */
anuncios.get('/recomendaciones', async (c) => {
  try {
    const tid = c.req.query('tenant_id');
    if (!tid && c.req.query('refresh') !== '1' && cacheRecs && Date.now() - cacheRecs.en < RECS_TTL) {
      return ok(c, { ...cacheRecs.datos, desde_cache: true });
    }
    const todos = await destinatarios();
    const objetivo = tid ? todos.filter(d => d.tenant_id === tid) : todos;

    /**
     * De a tandas, no de a uno.
     *
     * Secuencial tardaba 87 segundos y la pantalla parecía colgada. De a
     * ocho negocios a la vez baja a unos pocos segundos sin castigar a la
     * base con cincuenta consultas simultáneas.
     */
    const salida: any[] = [];
    const lote = objetivo.slice(0, 60);
    for (let i = 0; i < lote.length; i += 8) {
      const tanda = await Promise.all(lote.slice(i, i + 8).map(async (d) => {
        const recs = await recomendacionesPara(d.tenant_id, d.features);
        return recs.length
          ? { tenant_id: d.tenant_id, negocio: d.negocio, plan: d.plan, estado: d.estado, recomendaciones: recs }
          : null;
      }));
      for (const x of tanda) if (x) salida.push(x);
    }
    /** Los módulos desaprovechados por MÁS negocios: eso es lo que conviene anunciar. */
    const porModulo = new Map<string, number>();
    for (const x of salida) for (const r of x.recomendaciones) {
      porModulo.set(r.modulo, (porModulo.get(r.modulo) ?? 0) + 1);
    }
    const datos = {
      negocios: salida,
      mas_desaprovechados: [...porModulo.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([modulo, negocios]) => ({ modulo, negocios })),
    };
    if (!tid) cacheRecs = { en: Date.now(), datos };
    return ok(c, { ...datos, desde_cache: false });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** GET / — los anuncios que ya se mandaron. */
anuncios.get('/', async (c) => {
  try {
    const { data, error } = await db.from('anuncios')
      .select('*').order('created_at', { ascending: false }).limit(50);
    if (error) {
      if (/anuncios/.test(error.message)) return ok(c, { sin_tabla: true, anuncios: [] });
      throw new Error(error.message);
    }
    return ok(c, { anuncios: data ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * DESPACHAR UN ANUNCIO, por tandas y reanudable.
 *
 * ── Por qué por tandas ───────────────────────────────────────────────────
 * Entre mensaje y mensaje hay una pausa de más de un segundo (una ráfaga de
 * envíos seguidos es el patrón que hace que WhatsApp marque la cuenta). Con
 * veintisiete destinatarios eso son treinta y dos segundos, y la función del
 * servidor se corta a los treinta: la tanda quedaba a medio mandar, unos
 * recibían y otros no, y quien apretó el botón veía un error de red sin saber
 * a quién le había llegado.
 *
 * Ahora cada corrida manda lo que le entra en su presupuesto de tiempo y
 * deja constancia de a quién. La siguiente —el botón otra vez, o el trabajo
 * programado— sigue por donde quedó. El índice único de `anuncio_envios`
 * (anuncio + negocio) es lo que garantiza que nadie reciba dos veces.
 */
export async function despacharAnuncio(
  anuncioId: string, presupuestoMs = 20_000,
): Promise<{ enviados: number; fallidos: number; faltan: number; errores: string[] }> {
  const hasta = Date.now() + presupuestoMs;

  const { data: anuncio } = await db.from('anuncios')
    .select('mensaje, segmento').eq('id', anuncioId).maybeSingle();
  if (!anuncio) return { enviados: 0, fallidos: 0, faltan: 0, errores: ['Anuncio no encontrado'] };
  const seg: any = (anuncio as any).segmento ?? {};
  const mensaje = String((anuncio as any).mensaje ?? '');

  const todos = await destinatarios();
  /**
   * A QUIÉN LE TOCA, exactamente.
   *
   * Si al mandar se eligieron negocios uno por uno, esa lista MANDA sobre
   * los filtros. Importa que sea así también acá y no solo al apretar el
   * botón: este despachador corre otra vez después —desde el trabajo
   * programado o al reintentar— y si rearmara la lista desde los filtros,
   * la segunda corrida le escribiría a gente que se había destildado a
   * propósito.
   */
  const elegidos: string[] = Array.isArray(seg.tenant_ids) ? seg.tenant_ids : [];
  const lista = elegidos.length > 0
    ? todos.filter(d => elegidos.includes(d.tenant_id) && d.telefono)
    : todos.filter(d =>
        ((seg.planes ?? []).length === 0 || (seg.planes ?? []).includes(d.plan_id))
        && (seg.estados ?? ['al_dia']).includes(d.estado)
        && d.telefono);

  // A quién YA se le mandó (o se intentó): no se repite.
  const { data: yaIntentados } = await db.from('anuncio_envios')
    .select('tenant_id').eq('anuncio_id', anuncioId);
  const hechos = new Set(((yaIntentados ?? []) as any[]).map(x => x.tenant_id));
  const pendientes = lista.filter(d => !hechos.has(d.tenant_id));

  let enviados = 0, fallidos = 0;
  const errores: string[] = [];
  for (const d of pendientes) {
    if (Date.now() > hasta) break;             // se acabó el presupuesto: sigue la próxima
    const r = await enviarAnuncio(d.telefono!, mensaje);
    if (r.ok) enviados += 1;
    else { fallidos += 1; if (r.error && errores.length < 5) errores.push(`${d.negocio}: ${r.error}`); }
    await db.from('anuncio_envios').insert({
      anuncio_id: anuncioId, tenant_id: d.tenant_id,
      telefono: d.telefono, ok: r.ok, error: r.error ?? null,
    }).then(() => {}, () => {});
    await new Promise(res => setTimeout(res, 1200));
  }

  const faltan = pendientes.length - enviados - fallidos;
  // Los totales se recalculan de la tabla de envíos, no se suman a ciegas:
  // así quedan bien aunque una corrida se haya cortado a la mitad.
  const { data: todosEnvios } = await db.from('anuncio_envios')
    .select('ok').eq('anuncio_id', anuncioId);
  const okTotal = ((todosEnvios ?? []) as any[]).filter(x => x.ok).length;
  const malTotal = ((todosEnvios ?? []) as any[]).length - okTotal;
  await db.from('anuncios').update({
    enviados: okTotal, fallidos: malTotal,
    estado: faltan > 0 ? 'enviando' : 'enviado',
    sent_at: new Date().toISOString(),
  }).eq('id', anuncioId);

  return { enviados, fallidos, faltan, errores };
}

/**
 * GET /pendientes — los programados que todavía no salieron.
 *
 * Incluye los que quedaron a medio mandar: para quien mira, «faltan ocho» y
 * «sale mañana a las 9» son el mismo tipo de cosa, algo que todavía no
 * terminó.
 */
anuncios.get('/pendientes', async (c) => {
  try {
    const { data, error } = await db.from('anuncios')
      .select('*').in('estado', ['programado', 'enviando'])
      .order('programado_para', { ascending: true });
    if (error) {
      if (/anuncios|programado_para/.test(error.message)) return ok(c, { sin_tabla: true, pendientes: [] });
      throw new Error(error.message);
    }
    return ok(c, { pendientes: data ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** DELETE /:id — cancelar uno programado. No borra los que ya salieron. */
anuncios.delete('/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const { data: a } = await db.from('anuncios').select('estado').eq('id', id).maybeSingle();
    if (!a) return fail(c, 'No encontrado', 404);
    if ((a as any).estado === 'enviado') {
      return fail(c, 'Ese anuncio ya salió: no se puede cancelar lo que la gente ya recibió.', 422);
    }
    const { error } = await db.from('anuncios').update({ estado: 'cancelado' }).eq('id', id);
    if (error) throw new Error(error.message);
    return ok(c, { cancelado: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * DESPACHAR LO QUE TOCA. Lo llama el trabajo programado.
 *
 * Toma los anuncios cuya hora ya pasó y los que quedaron a medias, y les da
 * tiempo a cada uno. El presupuesto total queda por debajo del límite de la
 * función: más vale terminar la semana que viene que cortarse a la mitad.
 */
export async function despacharPendientes(presupuestoMs = 20_000) {
  const ahora = new Date().toISOString();
  const { data, error } = await db.from('anuncios')
    .select('id, estado, programado_para')
    .in('estado', ['programado', 'enviando'])
    .order('programado_para', { ascending: true }).limit(10);
  if (error) return { revisados: 0, despachados: [] as any[] };

  const hasta = Date.now() + presupuestoMs;
  const despachados: any[] = [];
  for (const a of ((data ?? []) as any[])) {
    if (Date.now() > hasta) break;
    // Un programado para más adelante no se toca; uno «enviando» sí, siempre.
    if (a.estado === 'programado' && a.programado_para && String(a.programado_para) > ahora) continue;
    const r = await despacharAnuncio(a.id, Math.max(3000, hasta - Date.now()));
    despachados.push({ id: a.id, ...r });
  }
  return { revisados: (data ?? []).length, despachados };
}

/**
 * POST /enviar  { titulo, mensaje, planes[], estados[], prueba?, programar_para? }
 *
 * `prueba` manda el anuncio a UN solo número y no registra nada. Es el paso
 * que conviene dar siempre antes de la tanda: un error de redacción visto en
 * el propio teléfono cuesta cero, y visto por cuarenta clientes no se puede
 * deshacer.
 */
anuncios.post('/enviar', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({} as any));
    const titulo = String(b?.titulo ?? '').trim();
    const mensaje = String(b?.mensaje ?? '').trim();
    if (!mensaje) return fail(c, 'Escribí el mensaje', 422);
    if (mensaje.length > 1200) return fail(c, 'El mensaje es muy largo (máximo 1200 caracteres)', 422);

    // ── Envío de prueba ──
    const prueba = String(b?.prueba ?? '').trim();
    if (prueba) {
      const r = await enviarAnuncio(prueba, mensaje);
      return ok(c, { prueba: true, ok: r.ok, error: r.error ?? null });
    }

    if (!titulo) return fail(c, 'Ponele un título al anuncio (para la bitácora)', 422);

    const planes: string[] = Array.isArray(b?.planes) ? b.planes : [];
    const estados: Estado[] = Array.isArray(b?.estados) ? b.estados : ['al_dia'];
    /** Negocios elegidos uno por uno. Si vienen, mandan sobre los filtros. */
    const tenantIds: string[] = Array.isArray(b?.tenant_ids) ? b.tenant_ids.map(String) : [];

    const todos = await destinatarios();
    const lista = tenantIds.length > 0
      ? todos.filter(d => tenantIds.includes(d.tenant_id) && d.telefono)
      : todos.filter(d =>
          (planes.length === 0 || planes.includes(d.plan_id))
          && estados.includes(d.estado)
          && d.telefono);

    if (lista.length === 0) {
      return fail(c, tenantIds.length > 0
        ? 'Ninguno de los negocios que elegiste tiene teléfono registrado.'
        : 'Con esos filtros no queda nadie con teléfono registrado.', 422);
    }

    /**
     * ¿Ahora o más tarde?
     *
     * La hora llega en UTC desde la pantalla, que la convierte desde la hora
     * de Costa Rica. Acá solo se valida que sea futura: programar algo para
     * ayer no es un error de tipeo recuperable —saldría de inmediato y sin
     * que nadie lo esperara—, así que se rechaza.
     */
    const cuando = String(b?.programar_para ?? '').trim();
    let programado: string | null = null;
    if (cuando) {
      const t = new Date(cuando);
      if (!Number.isFinite(t.getTime())) return fail(c, 'La fecha y hora no se entienden', 422);
      if (t.getTime() < Date.now() - 60_000) {
        return fail(c, 'Esa hora ya pasó. Elegí una futura, o mandalo ahora mismo.', 422);
      }
      programado = t.toISOString();
    }

    const { data: creado, error: errA } = await db.from('anuncios').insert({
      titulo, mensaje,
      estado: programado ? 'programado' : 'enviando',
      programado_para: programado,
      // La lista exacta queda guardada: es lo que vuelve reanudable el envío
      // sin riesgo de ampliar el público por el camino.
      segmento: {
        planes, estados, destinatarios: lista.length,
        tenant_ids: tenantIds.length > 0 ? lista.map(d => d.tenant_id) : undefined,
      },
    }).select('id').single();
    if (errA) throw new Error(errA.message);
    const anuncioId = (creado as any).id;

    if (programado) {
      return ok(c, {
        id: anuncioId, programado: true, para: programado, destinatarios: lista.length,
      });
    }

    /**
     * Se manda lo que entre en veinte segundos y el resto queda pendiente.
     *
     * La función del servidor se corta a los treinta, y con la pausa entre
     * mensajes veintisiete destinatarios no caben. Lo que falte lo sigue el
     * trabajo programado, o el mismo botón otra vez: nadie recibe dos veces.
     */
    const r = await despacharAnuncio(anuncioId, 20_000);
    return ok(c, { id: anuncioId, ...r });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default anuncios;
