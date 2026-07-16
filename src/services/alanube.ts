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

/** Normaliza cualquier valor a 'sandbox' (QA) | 'production'. */
export function normalizeEnv(e?: string | null): AlanubeEnv {
  const v = String(e ?? '').trim().toLowerCase();
  return v === 'production' || v === 'prod' || v === 'produccion' || v === 'producción' ? 'production' : 'sandbox';
}

/** Ambiente global por defecto (fallback si el tenant no define el suyo). */
function defaultEnv(): AlanubeEnv {
  return normalizeEnv(process.env.ALANUBE_ENV);
}

/** Base URL del ambiente. Solo override ESPECÍFICO por ambiente; el genérico
 *  `ALANUBE_BASE_URL` se ignora a propósito (apuntaba a sandbox y contaminaba
 *  producción). Sin override específico se usa la URL oficial de cada ambiente. */
function baseUrlFor(env: AlanubeEnv): string {
  const override = env === 'production'
    ? process.env.ALANUBE_BASE_URL_PRODUCTION
    : (process.env.ALANUBE_BASE_URL_SANDBOX || process.env.ALANUBE_BASE_URL_QA);
  return (override || '').trim().replace(/\/+$/, '') || DEFAULT_BASE[env];
}

/** Token del ambiente. Producción usa SOLO `ALANUBE_API_TOKEN_PRODUCTION` (el
 *  legacy `ALANUBE_API_TOKEN` era el de sandbox y no debe usarse en prod).
 *  Sandbox/QA usa el suyo, con fallback al legacy. */
function tokenFor(env: AlanubeEnv): string {
  const specific = env === 'production'
    ? process.env.ALANUBE_API_TOKEN_PRODUCTION
    : (process.env.ALANUBE_API_TOKEN_SANDBOX || process.env.ALANUBE_API_TOKEN_QA || process.env.ALANUBE_API_TOKEN);
  const t = (specific || '').trim();
  if (!t) throw new AlanubeError(`Falta el token de Alanube para el ambiente ${env}. Configurá ALANUBE_API_TOKEN_${env === 'production' ? 'PRODUCTION' : 'SANDBOX'} en el servidor.`, 500);
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

/** Llamada base al API de Alanube (Bearer + JSON) en un ambiente dado. */
async function alanubeFetch<T = any>(base: string, tok: string, path: string, init: RequestInit = {}): Promise<T> {
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetchWithTimeout(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tok}`,
      ...(init.headers ?? {}),
    },
  }).catch((err) => {
    const cause = (err as any)?.cause;
    const detail = cause?.code || cause?.message || err?.message || 'fetch failed';
    throw new AlanubeError(`No se pudo conectar con Alanube (${base}): ${detail}`);
  });

  const text = await res.text().catch(() => '');
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

  if (!res.ok) {
    // Extraer detalle de validación campo por campo, sin importar el formato:
    //  · errors: [{ field/path/property, message }]
    //  · errors: { campo: ["msg", ...] }   (object de arrays)
    //  · message / error string.
    const parts: string[] = [];
    const e = body?.errors;
    if (Array.isArray(e)) {
      for (const it of e) {
        if (typeof it === 'string') { parts.push(it); continue; }
        const field = it?.field ?? it?.path ?? it?.property ?? it?.param ?? '';
        const m = it?.message ?? it?.msg ?? JSON.stringify(it);
        parts.push(field ? `${field}: ${m}` : String(m));
      }
    } else if (e && typeof e === 'object') {
      for (const [field, val] of Object.entries(e)) {
        parts.push(`${field}: ${Array.isArray(val) ? val.join(', ') : val}`);
      }
    }
    const base = body?.message || body?.error || `Alanube respondió ${res.status}`;
    const msg = parts.length ? `${base} — ${parts.join(' · ')}` : base;
    throw new AlanubeError(msg, res.status === 401 || res.status === 403 ? 401 : res.status);
  }
  return body as T;
}

// Paths de emisión CRI por tipo de documento (versionados /v44).
const EMIT_PATH: Record<string, string> = {
  invoice: '/invoices/v44',
  ticket: '/tickets/v44',
  'credit-note': '/credit-notes/v44',
  'debit-note': '/debit-notes/v44',
};

/** Cliente Alanube atado a UN ambiente (sandbox/QA o producción). */
function clientFor(env: AlanubeEnv) {
  const base = baseUrlFor(env);
  const tok = tokenFor(env);
  const f = <T = any>(path: string, init: RequestInit = {}) => alanubeFetch<T>(base, tok, path, init);

  return {
    env,
    baseUrl: () => base,
    // CRI NO tiene un endpoint para listar/consultar la empresa 'main' sin su id.
    // Solo existe GET /companies/associated (empresas asociadas; `limit` obligatorio)
    // y GET /companies/{id}.
    getAssociated: (limit = 100) => f(`/companies/associated?limit=${limit}`, { method: 'GET' }),
    getCompany: (id: string) => f(`/companies/${id}`, { method: 'GET' }),
    createCompany: (payload: Record<string, any>) =>
      f('/companies', { method: 'POST', body: JSON.stringify(payload) }),
    updateCompany: async (id: string, payload: Record<string, any>) => {
      try {
        return await f(`/companies/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } catch (e: any) {
        if (e instanceof AlanubeError && (e.status === 404 || e.status === 405)) {
          return await f(`/companies/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        }
        throw e;
      }
    },
    emitDocument: (kind: 'invoice' | 'ticket' | 'credit-note' | 'debit-note', _payload: Record<string, any>, _companyId?: string) => {
      // CRI emite SIEMPRE con la empresa 'main' de la cuenta: NO hay parámetro
      // idCompany (ni body, ni header, ni query). El companyId se ignora acá.
      return f(EMIT_PATH[kind], { method: 'POST', body: JSON.stringify(_payload) });
    },
    // Consulta el ESTATUS de un documento en CRI:
    //   GET /cri/v1/{recurso}/{id}   (recurso = invoices|tickets|credit-notes|
    //   debit-notes, SIN /v44; id = ULID). Probamos según el tipo.
    getDocument: async (id: string, opts?: { kind?: 'invoice' | 'ticket' | 'credit-note' | 'debit-note'; companyId?: string; documents?: string }) => {
      const res: Record<string, string> = {
        invoice: 'invoices', ticket: 'tickets',
        'credit-note': 'credit-notes', 'debit-note': 'debit-notes',
      };
      const order = opts?.kind
        ? [opts.kind, ...Object.keys(res).filter(k => k !== opts.kind)]
        : Object.keys(res);
      // ?documents=xml,xmlHacienda,pdf para traer los archivos del comprobante.
      const qs = opts?.documents ? `?documents=${encodeURIComponent(opts.documents)}` : '';
      let lastErr: any = null;
      for (const k of order) {
        try { return await f(`/${res[k]}/${id}${qs}`, { method: 'GET' }); }
        catch (e: any) {
          if (e instanceof AlanubeError && (e.status === 404 || e.status === 400)) { lastErr = e; continue; }
          throw e;
        }
      }
      throw lastErr ?? new AlanubeError('Documento no encontrado', 404);
    },
    sendReceiverMessage: (payload: Record<string, any>, _companyId?: string) => {
      return f('/receiver-messages', { method: 'POST', body: JSON.stringify(payload) });
    },
    getReceiverMessage: (id: string, companyId?: string) => {
      const headers = companyId ? { idCompany: companyId, 'X-Company-Id': companyId } : undefined;
      return f(`/receiver-messages/${id}`, { method: 'GET', headers });
    },
  };
}

export type AlanubeClient = ReturnType<typeof clientFor>;

/** Resuelve el ambiente: valor explícito del tenant o, si no hay, el global. */
function resolveEnv(env?: string | null): AlanubeEnv {
  const v = String(env ?? '').trim().toLowerCase();
  if (v === 'production' || v === 'prod' || v === 'produccion' || v === 'producción') return 'production';
  if (v === 'sandbox' || v === 'qa' || v === 'test' || v === 'testing' || v === 'pruebas') return 'sandbox';
  return defaultEnv();   // sin valor explícito → ALANUBE_ENV global
}

export const alanube = {
  normalizeEnv,
  /** Ambiente global por defecto (si un tenant no define el suyo). */
  defaultEnv,
  /** Cliente para el ambiente de un tenant: alanube.forEnv(cfg.environment). */
  forEnv: (env?: string | null): AlanubeClient => clientFor(resolveEnv(env)),
};
