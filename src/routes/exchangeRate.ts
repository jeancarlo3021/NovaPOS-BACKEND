import { Hono } from 'hono';
import { ok } from '../utils/response.js';

// Tipo de cambio del dólar (BCCR). Fuente pública que devuelve el tipo de cambio
// oficial del Banco Central de Costa Rica del día (compra/venta), sin auth.
// Se cachea en memoria por fecha (CR) para no golpear la fuente en cada venta.
const exchangeRate = new Hono();

const SOURCE = 'https://tipodecambio.paginasweb.cr/api';

interface RateCache { date: string; venta: number; compra: number; source: string; }
let cache: RateCache | null = null;

/** Fecha de hoy en Costa Rica (YYYY-MM-DD). */
function todayCR(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
}

async function fetchBCCR(): Promise<{ venta: number; compra: number }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(SOURCE, { signal: ctrl.signal });
    const body: any = await res.json();
    const venta = Number(body?.venta ?? body?.sell ?? body?.dolar?.venta);
    const compra = Number(body?.compra ?? body?.buy ?? body?.dolar?.compra);
    if (!venta || isNaN(venta)) throw new Error('Respuesta sin tipo de cambio');
    return { venta, compra: compra || venta };
  } finally { clearTimeout(t); }
}

// GET /exchange-rate — { date, venta, compra, source } del día (CR).
exchangeRate.get('/', async (c) => {
  const date = todayCR();
  if (cache && cache.date === date) return ok(c, cache);
  try {
    const { venta, compra } = await fetchBCCR();
    cache = { date, venta, compra, source: 'BCCR' };
    return ok(c, cache);
  } catch {
    // Fallback: último valor conocido (aunque sea de otro día) o un default seguro.
    if (cache) return ok(c, { ...cache, stale: true });
    return ok(c, { date, venta: 0, compra: 0, source: 'unavailable', stale: true });
  }
});

export default exchangeRate;
