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
    const summary = await fetchAndProcessReceivedEmails();
    return ok(c, { ok: true, ...summary });
  } catch (err: any) {
    return fail(c, err?.message ?? 'Error al procesar correos', 500);
  }
};

cron.get('/fetch-received-emails', handler);
cron.post('/fetch-received-emails', handler);

export default cron;
