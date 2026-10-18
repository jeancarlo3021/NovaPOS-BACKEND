import { Hono } from 'hono';
import { ok } from '../utils/response.js';
import { db } from '../db/client.js';
import { leerGlobal, guardarGlobal } from '../services/globalSettings.js';

/**
 * Tipo de cambio del dólar (BCCR).
 *
 * ── Por qué no alcanza con una fuente y un caché en memoria ────────────────
 * La versión anterior consultaba UN solo sitio y guardaba el resultado en una
 * variable del proceso. En un servidor sin estado —como el que corre este
 * backend— cada arranque en frío nace con esa variable vacía, así que el
 * "último valor conocido" que hacía de respaldo casi nunca existía. Si la fuente
 * no contestaba en ese momento, la respuesta era `venta: 0`… y con eso el POS
 * escondía el cobro en dólares sin decir por qué.
 *
 * Ahora hay tres niveles, de más fresco a más viejo:
 *   1. Memoria del proceso (gratis, mientras dure).
 *   2. Dos fuentes oficiales, en orden. Si la primera falla, se prueba la otra.
 *   3. El último valor guardado en la BASE, que sí sobrevive a los reinicios.
 *
 * Un tipo de cambio de ayer sirve para cobrar; ninguno, no. Por eso lo viejo se
 * devuelve marcado como `stale` en vez de devolver cero.
 */
const exchangeRate = new Hono();

interface RateCache { date: string; venta: number; compra: number; source: string }
let cache: RateCache | null = null;

/** Fecha de hoy en Costa Rica (YYYY-MM-DD). */
function todayCR(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
}

type Source = { name: string; url: string; parse: (b: any) => { venta: number; compra: number } };

// El orden importa: primero la de Hacienda, que es la oficial y la que el
// contribuyente puede citar si alguien discute el tipo de cambio de una venta.
const SOURCES: Source[] = [
  {
    name: 'Hacienda',
    url: 'https://api.hacienda.go.cr/indicadores/tc/dolar',
    parse: (b) => ({
      venta: Number(b?.venta?.valor),
      compra: Number(b?.compra?.valor),
    }),
  },
  {
    name: 'BCCR',
    url: 'https://tipodecambio.paginasweb.cr/api',
    parse: (b) => ({
      venta: Number(b?.venta ?? b?.sell ?? b?.dolar?.venta),
      compra: Number(b?.compra ?? b?.buy ?? b?.dolar?.compra),
    }),
  },
];

async function fetchFrom(src: Source): Promise<{ venta: number; compra: number }> {
  const ctrl = new AbortController();
  // 6 s por fuente: con dos fuentes, el peor caso son 12 s. Más que eso y el
  // cajero se queda mirando el modal de cobro sin entender qué pasa.
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(src.url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { venta, compra } = src.parse(await res.json());
    if (!venta || !Number.isFinite(venta)) throw new Error('respuesta sin tipo de cambio');
    return { venta, compra: compra && Number.isFinite(compra) ? compra : venta };
  } finally { clearTimeout(t); }
}

/**
 * Guarda el último tipo de cambio conocido. Sobrevive a los reinicios.
 *
 * Va a `global_settings` y no a `settings`. Antes escribía en `settings` con
 * un `tenant_id` de ceros, y eso NUNCA funcionó: esa columna tiene clave
 * foránea contra `tenants`, el insert fallaba por integridad y el error
 * quedaba atrapado en el `catch`. Medido contra la base de producción: cero
 * filas guardadas en toda la vida del sistema.
 *
 * No era un detalle. `lastKnown()` existe para que, si el BCCR está caído, se
 * use el último valor conocido en vez de quedarse sin tipo de cambio; como
 * nunca se guardó ninguno, ese respaldo nunca tuvo nada que devolver.
 */
async function persist(r: RateCache): Promise<void> {
  await guardarGlobal('exchange-rate', r);
}

/** Último tipo de cambio guardado, de cualquier día. */
async function lastKnown(): Promise<RateCache | null> {
  const c = await leerGlobal<RateCache>('exchange-rate');
  return c && (c as any).venta > 0 ? c : null;
}

// GET /exchange-rate — { date, venta, compra, source, stale? } del día (CR).
exchangeRate.get('/', async (c) => {
  const date = todayCR();
  if (cache && cache.date === date) return ok(c, cache);

  const errors: string[] = [];
  for (const src of SOURCES) {
    try {
      const { venta, compra } = await fetchFrom(src);
      cache = { date, venta, compra, source: src.name };
      void persist(cache);
      return ok(c, cache);
    } catch (e: any) {
      errors.push(`${src.name}: ${e?.message ?? 'error'}`);
    }
  }

  // Ninguna fuente respondió. Se devuelve lo último conocido —de la memoria o de
  // la base— marcado como viejo: cobrar con el tipo de cambio de ayer es mucho
  // mejor que no poder cobrar en dólares.
  const fallback = cache ?? await lastKnown();
  if (fallback) {
    return ok(c, { ...fallback, stale: true, reason: errors.join(' · ') });
  }
  return ok(c, {
    date, venta: 0, compra: 0, source: 'unavailable', stale: true,
    reason: errors.join(' · ') || 'sin fuentes disponibles',
  });
});

export default exchangeRate;
