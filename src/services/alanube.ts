/**
 * Cliente de transporte para Alanube (Facturación Electrónica — Costa Rica).
 *
 * Modelo:
 *  - Token Bearer (JWT) de TU cuenta Alanube en ALANUBE_API_TOKEN (secreto, solo backend).
 *  - Ambiente en ALANUBE_ENV ('sandbox' | 'production'); base URL por defecto según
 *    ambiente, o override con ALANUBE_BASE_URL.
 *  - Alanube genera clave/consecutivo, firma con el .p12 y transmite a Hacienda.
 *
 * Paso 2: solo transporte + verificación de conexión + stubs de emisión/estado.
 * Los PATHS exactos del API CRI (crear empresa, emitir, consultar) se confirman
 * contra la doc de Alanube y se ajustan acá en un solo lugar.
 */

const DEFAULT_BASE: Record<string, string> = {
  sandbox:    'https://sandbox-api.alanube.co/cri/v1',
  production: 'https://api.alanube.co/cri/v1',
};

export type AlanubeEnv = 'sandbox' | 'production';

function alanubeEnv(): AlanubeEnv {
  return (process.env.ALANUBE_ENV || '').trim() === 'production' ? 'production' : 'sandbox';
}

function baseUrl(): string {
  const override = (process.env.ALANUBE_BASE_URL || '').trim().replace(/\/+$/, '');
  return override || DEFAULT_BASE[alanubeEnv()];
}

function token(): string {
  const t = (process.env.ALANUBE_API_TOKEN || '').trim();
  if (!t) throw new AlanubeError('Falta ALANUBE_API_TOKEN en el servidor. Configurá la variable de entorno.', 500);
  return t;
}

export class AlanubeError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

const fetchWithTimeout: typeof fetch = (input, init) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
};

/** Llamada base al API de Alanube (Bearer + JSON). Expone errores de red y de API. */
async function alanubeFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${baseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetchWithTimeout(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token()}`,
      ...(init.headers ?? {}),
    },
  }).catch((err) => {
    const cause = (err as any)?.cause;
    const detail = cause?.code || cause?.message || err?.message || 'fetch failed';
    throw new AlanubeError(`No se pudo conectar con Alanube (${baseUrl()}): ${detail}`);
  });

  const text = await res.text().catch(() => '');
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

  if (!res.ok) {
    const msg = body?.message || body?.error || (Array.isArray(body?.errors) ? body.errors.map((e: any) => e.message || e).join('; ') : '')
      || `Alanube respondió ${res.status}`;
    throw new AlanubeError(`${msg}`, res.status === 401 || res.status === 403 ? 401 : res.status);
  }
  return body as T;
}

export const alanube = {
  env: alanubeEnv,
  baseUrl,
  /** Verifica que el token y el ambiente funcionen (lista empresas de la cuenta). */
  ping: () => alanubeFetch('/companies', { method: 'GET' }),
  /** Crea/registra una empresa (emisor) en Alanube. CONFIRMADO: POST /cri/v1/companies. */
  createCompany: (payload: Record<string, any>) =>
    alanubeFetch('/companies', { method: 'POST', body: JSON.stringify(payload) }),
  /** Emite factura electrónica. Sigue el patrón versionado (POST /purchase-invoices/v44
   *  está confirmado; ventas debería ser /invoices/v44 — confirmar en la doc CRI). */
  emitVoucher: (payload: Record<string, any>) =>
    alanubeFetch('/invoices/v44', { method: 'POST', body: JSON.stringify(payload) }),
  /** Consulta el estado de un documento por su id (ULID). PATH a confirmar. */
  getDocument: (id: string) =>
    alanubeFetch(`/documents/${id}`, { method: 'GET' }),
};
