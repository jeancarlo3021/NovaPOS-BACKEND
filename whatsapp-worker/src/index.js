/**
 * ColónClick — Worker de WhatsApp (Baileys).
 *
 * Mantiene UNA sesión de WhatsApp vinculada por QR (estilo WhatsApp Web) y la
 * conserva viva. Expone HTTP (protegido por secreto compartido) para que el
 * backend Hono lo consuma:
 *
 *   GET  /health              → { ok: true }
 *   GET  /status              → { state, qr?, me? }
 *   POST /send { to, text }   → envía un mensaje de texto
 *   POST /logout              → cierra la sesión (borra credenciales)
 *
 * ⚠️ NO va en Vercel (serverless). Deployá en un host SIEMPRE ENCENDIDO y con
 *    disco persistente (Railway con Volume, Render con Disk, Fly.io, o un VPS).
 *    La carpeta de credenciales (AUTH_DIR) debe sobrevivir reinicios, o habrá
 *    que re-escanear el QR en cada deploy.
 *
 * Variables de entorno:
 *   WORKER_SECRET   secreto compartido con el backend (obligatorio).
 *   PORT            puerto HTTP (default 8088).
 *   AUTH_DIR        carpeta de credenciales (default ./auth — usá un volumen).
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import qrcode from 'qrcode';
import pino from 'pino';
import baileys, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

// Baileys exporta el default como makeWASocket.
const makeWASocket = baileys.default ?? baileys;

const WORKER_SECRET = (process.env.WORKER_SECRET || '').trim();
const PORT = Number(process.env.PORT) || 8088;
const AUTH_DIR = process.env.AUTH_DIR || './auth';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// ── Estado en memoria de la sesión ──────────────────────────────────────────
let sock = null;
let connState = 'connecting';     // 'connecting' | 'qr' | 'open' | 'close'
let currentQrDataUrl = null;      // data:image/png;base64,... (mientras haya QR)
let meInfo = null;                // { id, name } cuando está conectado
let starting = false;

/** Normaliza un teléfono a JID de WhatsApp. CR: 8 dígitos → 506XXXXXXXX. */
function toJid(raw) {
  let d = String(raw ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return '';
  if (d.length === 8) d = '506' + d;
  return `${d}@s.whatsapp.net`;
}

async function startSock() {
  if (starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ['ColónClick', 'Chrome', '1.0.0'],
      logger: pino({ level: 'silent' }),
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connState = 'qr';
        try { currentQrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 }); }
        catch { currentQrDataUrl = null; }
        log.info('QR nuevo generado — escanealo desde el panel admin');
      }

      if (connection === 'open') {
        connState = 'open';
        currentQrDataUrl = null;
        meInfo = { id: sock?.user?.id ?? null, name: sock?.user?.name ?? null };
        log.info({ me: meInfo }, 'WhatsApp conectado');
      }

      if (connection === 'close') {
        connState = 'close';
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        log.warn({ code, loggedOut }, 'Conexión cerrada');
        starting = false;
        if (loggedOut) {
          // Sesión invalidada: hay que re-escanear. No reconectamos con creds viejas.
          meInfo = null;
          currentQrDataUrl = null;
        } else {
          // Corte transitorio → reconectar.
          setTimeout(() => startSock().catch(() => {}), 2000);
        }
        return;
      }
    });
  } catch (e) {
    log.error({ err: String(e) }, 'Fallo al iniciar el socket');
    setTimeout(() => { starting = false; startSock().catch(() => {}); }, 5000);
    return;
  }
  starting = false;
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const app = new Hono();

// Auth por secreto compartido (excepto /health).
app.use('*', async (c, next) => {
  if (c.req.path === '/health') return next();
  const given = c.req.header('x-worker-secret') || '';
  if (!WORKER_SECRET || given !== WORKER_SECRET) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  return next();
});

app.get('/health', (c) => c.json({ ok: true }));

app.get('/status', (c) => c.json({
  ok: true,
  state: connState,                      // connecting | qr | open | close
  connected: connState === 'open',
  qr: connState === 'qr' ? currentQrDataUrl : null,
  me: meInfo,
}));

app.post('/send', async (c) => {
  if (connState !== 'open' || !sock) {
    return c.json({ ok: false, error: 'not_connected' }, 409);
  }
  let body;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'bad_json' }, 400); }
  const jid = toJid(body?.to);
  const text = String(body?.text ?? '').trim();
  if (!jid || !text) return c.json({ ok: false, error: 'missing_to_or_text' }, 400);
  try {
    // Verifica que el número tenga WhatsApp antes de enviar.
    const [exists] = await sock.onWhatsApp(jid.replace('@s.whatsapp.net', ''));
    if (!exists?.exists) return c.json({ ok: false, error: 'no_whatsapp' }, 422);
    const res = await sock.sendMessage(exists.jid, { text });
    return c.json({ ok: true, id: res?.key?.id ?? null });
  } catch (e) {
    log.error({ err: String(e) }, 'Error al enviar');
    return c.json({ ok: false, error: 'send_failed' }, 500);
  }
});

app.post('/logout', async (c) => {
  try { await sock?.logout(); } catch { /* ignore */ }
  connState = 'close';
  meInfo = null;
  currentQrDataUrl = null;
  // Reinicia para generar un QR nuevo.
  setTimeout(() => { starting = false; startSock().catch(() => {}); }, 500);
  return c.json({ ok: true });
});

if (!WORKER_SECRET) {
  log.warn('WORKER_SECRET vacío — el worker rechazará todas las peticiones. Configuralo.');
}

serve({ fetch: app.fetch, port: PORT }, () => {
  log.info(`WhatsApp worker → http://localhost:${PORT}  (AUTH_DIR=${AUTH_DIR})`);
});

startSock().catch((e) => log.error({ err: String(e) }, 'startSock inicial falló'));
