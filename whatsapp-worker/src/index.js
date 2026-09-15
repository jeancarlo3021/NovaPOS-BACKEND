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
import { createClient } from '@supabase/supabase-js';
import qrcode from 'qrcode';
import pino from 'pino';
import baileys, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { useSupabaseAuthState } from './authState.js';

// Baileys exporta el default como makeWASocket.
const makeWASocket = baileys.default ?? baileys;

const WORKER_SECRET = (process.env.WORKER_SECRET || '').trim();
const PORT = Number(process.env.PORT) || 8088;
const AUTH_DIR = process.env.AUTH_DIR || './auth';

// Persistencia de la sesión: Supabase (recomendado, sobrevive sin volumen) o disco.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_KEY);
let supabaseAuth = null;   // { state, saveCreds, clear } cuando se usa Supabase

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Versión del worker, visible en /status.
 *
 * El worker se despliega aparte del backend, así que desde el panel no había
 * forma de saber si el que está corriendo ya tiene un arreglo o es el de antes.
 * Subila EN CADA arreglo que se deba verificar desde afuera. Si no cambia, un
 * despliegue viejo y uno nuevo se ven iguales desde el panel — que fue justo lo
 * que pasó: la marca quedó igual entre dos arreglos y no se podía saber cuál
 * estaba corriendo.
 */
const WORKER_BUILD = '2026-09-14c-auth';

// ── Estado en memoria de la sesión ──────────────────────────────────────────
let sock = null;
let connState = 'connecting';     // 'connecting' | 'qr' | 'open' | 'close'
let estadoDesde = Date.now();     // cuándo entró al estado actual
let ultimoError = null;           // por qué falló el último intento

/** Cambia de estado anotando CUÁNDO: sin eso no se sabe si lleva 2 s o 5 min. */
function setEstado(nuevo) {
  if (nuevo !== connState) { connState = nuevo; estadoDesde = Date.now(); }
}
let currentQrDataUrl = null;      // data:image/png;base64,... (mientras haya QR)
let meInfo = null;                // { id, name } cuando está conectado
let starting = false;

/**
 * Últimos mensajes enviados, para poder REENVIARLOS si hace falta.
 *
 * Cuando el teléfono del destinatario no logra descifrar un mensaje, WhatsApp le
 * pide al emisor que lo mande de nuevo. Baileys responde a ese pedido llamando a
 * `getMessage`; sin eso, al destinatario le queda para siempre el aviso
 * «Esperando el mensaje. Esto puede demorar un poco».
 *
 * Se guardan en memoria y acotados: solo sirven para el reintento inmediato.
 */
const enviados = new Map();
const MAX_ENVIADOS = 300;

function recordarEnviado(id, contenido) {
  if (!id) return;
  enviados.set(id, contenido);
  // Se descarta el más viejo: un worker que vive semanas no puede crecer sin fin.
  if (enviados.size > MAX_ENVIADOS) enviados.delete(enviados.keys().next().value);
}

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
    let state, saveCreds;
    if (USE_SUPABASE) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
      supabaseAuth = await useSupabaseAuthState(supabase, 'colonclick');
      state = supabaseAuth.state;
      saveCreds = supabaseAuth.saveCreds;
    } else {
      const mf = await useMultiFileAuthState(AUTH_DIR);
      state = mf.state;
      saveCreds = mf.saveCreds;
    }
    /**
     * La versión del protocolo se consulta CON PLAZO.
     *
     * `fetchLatestBaileysVersion()` sale a internet, y se esperaba sin límite:
     * si el endpoint tardaba o estaba bloqueado, el worker se quedaba en
     * «conectando» para siempre y ni siquiera llegaba a mostrar el QR. Si no
     * responde a tiempo se usa la versión que trae la librería, que funciona.
     */
    let version;
    try {
      const r = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('tardó más de 6 s')), 6000)),
      ]);
      version = r?.version;
    } catch (e) {
      log.warn({ err: String(e) }, 'No se pudo consultar la versión del protocolo: se usa la incluida');
    }

    /**
     * Se cierra el socket ANTERIOR antes de abrir uno nuevo.
     *
     * Al reconectar se creaba otro sin soltar el viejo: quedaban dos sesiones
     * vivas con las mismas credenciales, cada una girando sus propias claves de
     * cifrado y pisando las de la otra. El resultado en el teléfono del
     * destinatario es «Esperando el mensaje», porque las claves ya no cuadran.
     */
    if (sock) {
      try { sock.ev.removeAllListeners(); } catch { /* ya estaba suelto */ }
      try { sock.end(undefined); } catch { /* ya estaba cerrado */ }
      sock = null;
    }

    sock = makeWASocket({
      // `undefined` = la que trae la librería (cuando la consulta no respondió).
      ...(version ? { version } : {}),
      auth: state,
      printQRInTerminal: false,
      browser: ['ColónClick', 'Chrome', '1.0.0'],
      logger: pino({ level: 'silent' }),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      // Responde los pedidos de reenvío: es lo que destraba «Esperando el mensaje».
      getMessage: async (key) => enviados.get(key?.id) ?? undefined,
      // Sin estos topes, un intento que no avanza se queda colgado sin reintentar.
      connectTimeoutMs: 30_000,
      qrTimeout: 60_000,
      keepAliveIntervalMs: 25_000,
    });

    /**
     * Si se queda en «conectando» sin llegar a QR ni a vincularse, se reinicia.
     *
     * Pasaba con un arranque a medias: el estado no avanzaba nunca y desde el
     * panel solo se veía «Conectando con WhatsApp…» sin más información.
     */
    setTimeout(() => {
      if (connState === 'connecting') {
        log.warn('Sigue en «conectando» tras 45 s: se reinicia el socket');
        ultimoError = 'El intento anterior no avanzó en 45 s y se reinició.';
        starting = false;
        startSock().catch(() => {});
      }
    }, 45_000);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        setEstado('qr');
        try { currentQrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 }); }
        catch { currentQrDataUrl = null; }
        log.info('QR nuevo generado — escanealo desde el panel admin');
      }

      if (connection === 'open') {
        setEstado('open');
        currentQrDataUrl = null;
        meInfo = { id: sock?.user?.id ?? null, name: sock?.user?.name ?? null };
        log.info({ me: meInfo }, 'WhatsApp conectado');
      }

      if (connection === 'close') {
        setEstado('close');
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        ultimoError = loggedOut
          ? 'La sesión se cerró desde el teléfono: hay que volver a escanear el QR.'
          : `Conexión cerrada (código ${code ?? '?'}): reintentando.`;
        log.warn({ code, loggedOut }, 'Conexión cerrada');
        starting = false;
        if (loggedOut) {
          // Sesión invalidada: borrar credenciales y reiniciar para un QR nuevo.
          meInfo = null;
          currentQrDataUrl = null;
          if (supabaseAuth) { try { await supabaseAuth.clear(); } catch { /* ignore */ } }
          setTimeout(() => { starting = false; startSock().catch(() => {}); }, 1500);
        } else {
          // Corte transitorio → reconectar (con las mismas credenciales).
          setTimeout(() => startSock().catch(() => {}), 2000);
        }
        return;
      }
    });
  } catch (e) {
    ultimoError = `No se pudo iniciar: ${String(e)}`;
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
  build: WORKER_BUILD,
  // Cuánto lleva en este estado y el último motivo de corte: sin esto, «conectando»
  // se ve igual a los 2 segundos que a los 5 minutos.
  segundos_en_estado: Math.round((Date.now() - estadoDesde) / 1000),
  ultimo_error: ultimoError,
  // Qué trae esta versión, para confirmar desde el panel que el arreglo está.
  features: { reenvio: true, socketUnico: true },
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
    const contenido = { text };
    const res = await sock.sendMessage(exists.jid, contenido);
    // Se guarda por si el destinatario pide que se lo reenvíen.
    recordarEnviado(res?.key?.id, { conversation: text });
    return c.json({ ok: true, id: res?.key?.id ?? null });
  } catch (e) {
    log.error({ err: String(e) }, 'Error al enviar');
    return c.json({ ok: false, error: 'send_failed' }, 500);
  }
});

app.post('/logout', async (c) => {
  try { await sock?.logout(); } catch { /* ignore */ }
  if (supabaseAuth) { try { await supabaseAuth.clear(); } catch { /* ignore */ } }
  setEstado('close');
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
  log.info(`WhatsApp worker → http://localhost:${PORT}  (persistencia: ${USE_SUPABASE ? 'Supabase (wa_sessions)' : `disco ${AUTH_DIR}`})`);
});

startSock().catch((e) => log.error({ err: String(e) }, 'startSock inicial falló'));
