import { Hono } from 'hono';
import { ok, fail } from '../utils/response.js';
import { fetchAndProcessReceivedEmails } from '../services/receivedEmails.js';

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
const handler = async (c: any) => {
  if (!authorized(c)) return fail(c, 'No autorizado', 401);
  try {
    const debug = c.req.query('debug') === '1';
    const summary = await fetchAndProcessReceivedEmails({ debug });

    /**
     * De paso se limpian las demos vencidas.
     *
     * El borrado tenía su propio trabajo programado (`/cron/purge-demos`), y si
     * ese no se configura NUNCA se ejecuta: las demos quedaban vivas para
     * siempre sin que nada lo avisara. Colgarlo del que sí corre lo vuelve
     * independiente de esa configuración. Nunca rompe la lectura de correos.
     */
    let demos: any = null;
    try {
      const { purgeExpiredDemos } = await import('../services/demoCleanup.js');
      demos = await purgeExpiredDemos();
    } catch (e: any) {
      console.warn('[cron] limpieza de demos:', e?.message);
    }
    /**
     * Avisos de cobro: 7, 4, 2 y 1 días antes del vencimiento, y después uno
     * DIARIO mientras corre el tiempo de gracia.
     *
     * Van acá por lo mismo que la limpieza de demos: este es el trabajo
     * programado que sí está corriendo. La tabla de avisos enviados impide que
     * se repitan, así que ejecutarlo cada pocos minutos es inofensivo.
     */
    let cobros: any = null;
    try {
      const { enviarAvisosDeCobro } = await import('../services/paymentReminders.js');
      cobros = await enviarAvisosDeCobro();
    } catch (e: any) {
      console.warn('[cron] avisos de cobro:', e?.message);
    }
    /**
     * Respaldo semanal de cada negocio.
     *
     * Va colgado de este trabajo por lo mismo que la limpieza de demos y los
     * avisos de cobro: es el único que está corriendo de verdad. Que exista el
     * archivo de la semana es la marca de «ya está», así que llamarlo cada pocos
     * minutos es inofensivo: respalda a los que falten y se detiene por tiempo.
     */
    let respaldos: any = null;
    try {
      const { respaldoSemanal } = await import('../services/tenantBackup.js');
      respaldos = await respaldoSemanal({ presupuestoMs: 18_000 });
    } catch (e: any) {
      console.warn('[cron] respaldos:', e?.message);
    }
    return ok(c, { ok: true, ...summary, demos, cobros, respaldos });
  } catch (err: any) {
    return fail(c, err?.message ?? 'Error al procesar correos', 500);
  }
};

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
// durante el tiempo de gracia. `?debug=1` solo informa a quién le tocaría hoy
// (y cuántos días de gracia le quedan), sin mandar nada.
const cobrosHandler = async (c: any) => {
  if (!authorized(c)) return fail(c, 'No autorizado', 401);
  try {
    const { enviarAvisosDeCobro } = await import('../services/paymentReminders.js');
    const res = await enviarAvisosDeCobro({ dryRun: c.req.query('debug') === '1' });
    return ok(c, { ok: true, simulacion: c.req.query('debug') === '1', ...res });
  } catch (err: any) {
    return fail(c, err?.message ?? 'Error al enviar los avisos de cobro', 500);
  }
};
cron.get('/payment-reminders', cobrosHandler);
cron.post('/payment-reminders', cobrosHandler);

// Respaldo semanal por negocio. `?debug=1` solo dice a quién le toca esta semana,
// sin escribir nada. Pensado para correr suelto cuando hay que forzarlo.
const respaldosHandler = async (c: any) => {
  if (!authorized(c)) return fail(c, 'No autorizado', 401);
  try {
    const { respaldoSemanal } = await import('../services/tenantBackup.js');
    const debug = c.req.query('debug') === '1';
    const res = await respaldoSemanal({
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
