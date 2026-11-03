import { Hono } from 'hono';
import { ok, fail } from '../utils/response.js';
import { fetchAndProcessReceivedEmails } from '../services/receivedEmails.js';
import { despacharPendientes } from './anuncios.js';

// Rutas de CRON — públicas pero protegidas por un token secreto (CRON_SECRET).
// Pensadas para un cron externo (cron-job.org) que las llama cada 15 min.
const cron = new Hono();

function authorized(c: any): boolean {
  // Recortamos espacios/saltos de línea (Vercel suele colar un \n al pegar el valor).
  const secret = (process.env.CRON_SECRET ?? '').trim();
  if (!secret) return false;                       // sin secreto configurado, se rechaza todo
  const header = (c.req.header('x-cron-secret') || c.req.header('authorization')?.replace(/^Bearer\s+/i, '') || '').trim();
  const query  = (c.req.query('token') ?? '').trim();
  return header === secret || query === secret;
}

// GET y POST — cron-job.org suele usar GET; aceptamos ambos.
/**
 * EL TRABAJO DE CADA CUARTO DE HORA.
 *
 * Hace cinco cosas, y todas se colgaron de acá por la misma razón: es el
 * único trabajo programado que está configurado de verdad. El problema es que
 * cada una llegó con su propio plazo —correos 22 s, respaldos 18 s, anuncios
 * 6 s— y la suma, 46 segundos, no cabe en los 30 que espera el cron externo.
 * No era lentitud: era que nunca podía terminar, y lo último de la fila no
 * corría nunca.
 *
 * Ahora hay UN presupuesto que se reparte (ver `cronPresupuesto.ts`): cada
 * tarea recibe lo que queda, la que no entra se salta y se dice, y el orden
 * rota para que a todas les toque ser primeras.
 */
const handler = async (c: any) => {
  if (!authorized(c)) return fail(c, 'No autorizado', 401);
  try {
    const debug = c.req.query('debug') === '1';
    /* Por omisión 25 s: debajo de los 30 que esperan tanto el cron externo
       como la función. Se ajusta con CRON_PRESUPUESTO_MS sin tocar código. */
    /* 18 s por omisión, no 25: el cron externo corta a los 30 y antes de que
       esto arranque ya se fue tiempo en levantar la función. El margen tiene
       que estar de nuestro lado. */
    const presupuestoMs = Math.max(8_000, Math.min(60_000, Number(process.env.CRON_PRESUPUESTO_MS) || 18_000));

    const { correrConPresupuesto } = await import('../services/cronPresupuesto.js');
    const r = await correrConPresupuesto([
      {
        /* Los correos van SIEMPRE primeros y fuera de la rotación: es la
           razón de ser de este trabajo, y una factura de proveedor que no se
           lee a tiempo es plata. Pero ya no se lleva 22 s fijos. */
        nombre: 'correos', minimoMs: 4_000,
        correr: (ms) => fetchAndProcessReceivedEmails({ debug, presupuestoMs: Math.min(ms, 14_000) }),
      },
    ], { presupuestoMs, turno: 0 });

    /* Lo demás, con lo que sobró y rotando el orden. */
    const restante = presupuestoMs - r.tardo_ms;
    const extra = await correrConPresupuesto([
      {
        nombre: 'demos', minimoMs: 1_500,
        correr: async () => (await import('../services/demoCleanup.js')).purgeExpiredDemos(),
      },
      {
        nombre: 'cobros', minimoMs: 1_500,
        correr: async () => (await import('../services/paymentReminders.js')).enviarAvisosDeCobro(),
      },
      {
        nombre: 'respaldos', minimoMs: 3_000,
        correr: async (ms) => (await import('../services/tenantBackup.js')).respaldoDiario({ presupuestoMs: ms }),
      },
      {
        nombre: 'anuncios', minimoMs: 2_000,
        correr: async (ms) => (await import('./anuncios.js')).despacharPendientes(Math.min(ms, 8_000)),
      },
    ], { presupuestoMs: Math.max(1_000, restante) });

    return ok(c, {
      ok: true,
      ...(r.resultados.correos ?? {}),
      demos: extra.resultados.demos ?? null,
      cobros: extra.resultados.cobros ?? null,
      respaldos: extra.resultados.respaldos ?? null,
      avisos: extra.resultados.anuncios ?? null,
      /* QUÉ NO ALCANZÓ A CORRER. Sin esto, una tarea saltada por tiempo es
         indistinguible de una que corrió y no hizo nada. */
      presupuesto: {
        ms: presupuestoMs, tardo_ms: r.tardo_ms + extra.tardo_ms,
        saltadas: [...r.saltadas, ...extra.saltadas].map(x => x.nombre),
        fallidas: [...r.fallidas, ...extra.fallidas],
      },
    });
  } catch (err: any) {
    return fail(c, err?.message ?? 'Error al procesar correos', 500);
  }
};

/**
 * Los ANUNCIOS programados.
 *
 * Tiene su propia dirección y además va colgado del trabajo de correos, que
 * es el que seguro está configurado. Un aviso que debía salir a las nueve y
 * sale a las nueve y cuarto no molesta a nadie; uno que no sale nunca porque
 * su cron no se configuró, sí.
 */
const anunciosHandler = async (c: any) => {
  if (!authorized(c)) return fail(c, 'No autorizado', 401);
  try {
    return ok(c, await despacharPendientes(20_000));
  } catch (err: any) { return fail(c, err.message, 500); }
};
cron.get('/anuncios', anunciosHandler);
cron.post('/anuncios', anunciosHandler);

cron.get('/fetch-received-emails', handler);
cron.post('/fetch-received-emails', handler);

// Limpieza de demos vencidas. `?debug=1` solo informa qué borraría, sin borrar:
// conviene mirarlo la primera vez antes de dejarlo suelto.
const purgeHandler = async (c: any) => {
  if (!authorized(c)) return fail(c, 'No autorizado', 401);
  try {
    const { purgeExpiredDemos } = await import('../services/demoCleanup.js');
    const res = await purgeExpiredDemos({ dryRun: c.req.query('debug') === '1' });
    return ok(c, { ok: true, ...res });
  } catch (err: any) {
    return fail(c, err?.message ?? 'Error al limpiar demos', 500);
  }
};
cron.get('/purge-demos', purgeHandler);
cron.post('/purge-demos', purgeHandler);

// Reintento de correos de comprobantes aceptados que no salieron al primer
// intento. Pensado para correr cada 15-30 minutos junto a los demás.
const reintentoCorreosHandler = async (c: any) => {
  if (!authorized(c)) return fail(c, 'No autorizado', 401);
  try {
    const { reintentarCorreosPendientes } = await import('./hacienda.js');
    const res = await reintentarCorreosPendientes({ limite: 25, presupuestoMs: 22_000 });
    return ok(c, { ok: true, ...res });
  } catch (err: any) {
    return fail(c, err?.message ?? 'Error al reintentar correos', 500);
  }
};
cron.get('/retry-fe-emails', reintentoCorreosHandler);
cron.post('/retry-fe-emails', reintentoCorreosHandler);

// Avisos de cobro por WhatsApp: 7, 4, 2 y 1 días antes de vencer, y uno por día
// durante el tiempo de gracia. Solo entre las 8 y las 20 de Costa Rica.
// `?debug=1` informa a quién le tocaría sin mandar nada; `?ahora=1` manda aunque
// sea fuera de ese horario.
const cobrosHandler = async (c: any) => {
  if (!authorized(c)) return fail(c, 'No autorizado', 401);
  try {
    const { enviarAvisosDeCobro } = await import('../services/paymentReminders.js');
    const res = await enviarAvisosDeCobro({
      dryRun: c.req.query('debug') === '1',
      // `?ahora=1` manda aunque sea fuera del horario: es para soporte, cuando
      // hay que avisarle a alguien en el momento.
      ignorarHorario: c.req.query('ahora') === '1',
    });
    return ok(c, { ok: true, simulacion: c.req.query('debug') === '1', ...res });
  } catch (err: any) {
    return fail(c, err?.message ?? 'Error al enviar los avisos de cobro', 500);
  }
};
cron.get('/payment-reminders', cobrosHandler);
cron.post('/payment-reminders', cobrosHandler);

// Respaldo diario por negocio. `?debug=1` solo dice a quién le toca hoy,
// sin escribir nada. Pensado para correr suelto cuando hay que forzarlo.
const respaldosHandler = async (c: any) => {
  if (!authorized(c)) return fail(c, 'No autorizado', 401);
  try {
    const { respaldoDiario } = await import('../services/tenantBackup.js');
    const debug = c.req.query('debug') === '1';
    const res = await respaldoDiario({
      dryRun: debug,
      // Suelto se le da más tiempo que colgado del cron de correos.
      presupuestoMs: Number(c.req.query('ms') ?? 25_000) || 25_000,
    });
    return ok(c, { ok: true, simulacion: debug, ...res });
  } catch (err: any) {
    return fail(c, err?.message ?? 'Error al respaldar', 500);
  }
};
cron.get('/backups', respaldosHandler);
cron.post('/backups', respaldosHandler);

export default cron;
