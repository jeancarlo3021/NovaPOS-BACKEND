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
 * POST /enviar  { titulo, mensaje, planes[], estados[], prueba? }
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
    const todos = await destinatarios();
    const lista = todos.filter(d =>
      (planes.length === 0 || planes.includes(d.plan_id))
      && estados.includes(d.estado)
      && d.telefono);

    if (lista.length === 0) {
      return fail(c, 'Con esos filtros no queda nadie con teléfono registrado.', 422);
    }

    const { data: creado, error: errA } = await db.from('anuncios').insert({
      titulo, mensaje, estado: 'enviado',
      segmento: { planes, estados, destinatarios: lista.length },
      sent_at: new Date().toISOString(),
    }).select('id').single();
    if (errA) throw new Error(errA.message);
    const anuncioId = (creado as any).id;

    let enviados = 0, fallidos = 0;
    const errores: string[] = [];
    for (const d of lista) {
      const r = await enviarAnuncio(d.telefono!, mensaje);
      if (r.ok) enviados += 1; else { fallidos += 1; if (r.error && errores.length < 5) errores.push(`${d.negocio}: ${r.error}`); }
      // Queda constancia incluso de los que fallaron: sin eso, reintentar
      // mandaría de nuevo a los que SÍ recibieron.
      await db.from('anuncio_envios').insert({
        anuncio_id: anuncioId, tenant_id: d.tenant_id,
        telefono: d.telefono, ok: r.ok, error: r.error ?? null,
      }).then(() => {}, () => {});
      // Un respiro entre mensajes: una ráfaga de cuarenta envíos seguidos es
      // justo el patrón que hace que WhatsApp marque la cuenta.
      await new Promise(res => setTimeout(res, 1200));
    }

    await db.from('anuncios').update({ enviados, fallidos }).eq('id', anuncioId);
    return ok(c, { id: anuncioId, enviados, fallidos, errores });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default anuncios;
