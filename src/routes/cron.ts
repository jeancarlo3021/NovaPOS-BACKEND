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
    return ok(c, { ok: true, ...summary });
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

export default cron;
