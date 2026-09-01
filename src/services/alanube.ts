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
function tokenFor(env: AlanubeEnv, override?: string | null): string {
  // Token PROPIO del tenant (Datos de FE). En Costa Rica cada cuenta de Alanube
  // admite UNA sola empresa emisora, así que un negocio que no comparte cédula con
  // el de la cuenta global necesita su propia cuenta/token.
  const own = (override || '').trim();
  if (own) return own;
  const specific = env === 'production'
    ? process.env.ALANUBE_API_TOKEN_PRODUCTION
    : (process.env.ALANUBE_API_TOKEN_SANDBOX || process.env.ALANUBE_API_TOKEN_QA || process.env.ALANUBE_API_TOKEN);
  const t = (specific || '').trim();
  if (!t) throw new AlanubeError(`Falta el token de Alanube para el ambiente ${env}. Configurá ALANUBE_API_TOKEN_${env === 'production' ? 'PRODUCTION' : 'SANDBOX'} en el servidor, o cargá el token propio del negocio en Datos de FE.`, 500);
  return t;
}

/** Token propio del tenant guardado en su config de FE, según el ambiente. */
export function tenantAlanubeToken(cfg: any, env: AlanubeEnv): string {
  if (!cfg) return '';
  const v = env === 'production'
    ? (cfg.alanube_token_production ?? cfg.alanube_api_token_production)
    : (cfg.alanube_token_sandbox ?? cfg.alanube_api_token_sandbox);
  return String(v ?? cfg.alanube_token ?? '').trim();
}

export class AlanubeError extends Error {
  status: number;
  body?: any;   // cuerpo crudo de la respuesta de error (suele traer el id de la empresa existente)
  constructor(message: string, status = 502, body?: any) { super(message); this.status = status; this.body = body; }
}

/** Timeout por defecto de una llamada a Alanube. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * `fetch` con corte por tiempo.
 *
 * El abort lleva RAZÓN: sin ella, Node lanza "signal is aborted without reason",
 * que era lo único que veía el usuario cuando un reporte tardaba de más — un
 * mensaje que no dice ni qué se estaba pidiendo ni que fue por tiempo.
 */
const fetchWithTimeout = (input: any, init: RequestInit & { timeoutMs?: number } = {}) => {
  const ms = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(
      `Alanube no respondió en ${Math.round(ms / 1000)} segundos.`
      + ' Suele ser un rango de fechas muy amplio: probá con un mes a la vez.',
    )),
    ms,
  );
  const { timeoutMs: _omit, ...rest } = init;
  return fetch(input, { ...rest, signal: ctrl.signal }).finally(() => clearTimeout(timer));
};

/** Llamada base al API de Alanube (Bearer + JSON) en un ambiente dado. */
async function alanubeFetch<T = any>(
  base: string, tok: string, path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetchWithTimeout(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tok}`,
      ...(init.headers ?? {}),
    },
  }).catch((err) => {
    // Corte por tiempo: se distingue de "no hay red" porque el arreglo es otro
    // (achicar el rango de fechas / reintentar), no revisar la conexión.
    if ((err as any)?.name === 'AbortError' || (err as any)?.name === 'TimeoutError') {
      const why = (err as any)?.cause?.message
        ?? `Alanube no respondió en ${Math.round((init.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} segundos`;
      throw new AlanubeError(`${why} (${path.split('?')[0]}). Probá con un rango de fechas más corto.`, 504);
    }
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
    throw new AlanubeError(msg, res.status === 401 || res.status === 403 ? 401 : res.status, body);
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
function clientFor(env: AlanubeEnv, tokenOverride?: string | null) {
  const base = baseUrlFor(env);
  const tok = tokenFor(env, tokenOverride);
  const f = <T = any>(path: string, init: RequestInit & { timeoutMs?: number } = {}) =>
    alanubeFetch<T>(base, tok, path, init);

  return {
    env,
    baseUrl: () => base,
    // CRI NO tiene un endpoint para listar/consultar la empresa 'main' sin su id.
    // Solo existe GET /companies/associated (empresas asociadas; `limit` obligatorio)
    // y GET /companies/{id}.
    getAssociated: (limit = 100) => f(`/companies/associated?limit=${limit}`, { method: 'GET' }),
    getCompany: (id: string) => f(`/companies/${id}`, { method: 'GET' }),
    // Empresa 'main' asociada al TOKEN (sin necesitar el id). Es la única forma de
    // recuperar el id de la empresa principal cuando no lo tenemos guardado.
    //   GET /cri/v1/company   (singular; la base ya incluye /cri/v1)
    getMainCompany: () => f('/company', { method: 'GET' }),
    // PDF del comprobante en BASE64 (endpoint dedicado). documentType:
    // invoice|ticket|credit-note|debit-note|purchase-invoice|export-invoice.
    getDocumentPdf: (idDocument: string, documentType: string, idCompany: string) => {
      const qs = new URLSearchParams({ idDocument, documentType, idCompany });
      return f(`/document-files/pdf?${qs.toString()}`, { method: 'GET' });
    },
    createCompany: (payload: Record<string, any>) =>
      f('/companies', { method: 'POST', body: JSON.stringify(payload) }),
    // Baja de una empresa. Se prueban las rutas conocidas porque CRI no documenta
    // el DELETE de forma estable: /companies/{id} y, si no, /company/{id}.
    deleteCompany: async (id: string) => {
      try {
        return await f(`/companies/${id}`, { method: 'DELETE' });
      } catch (e: any) {
        if (e instanceof AlanubeError && (e.status === 404 || e.status === 405)) {
          return await f(`/company/${id}`, { method: 'DELETE' });
        }
        throw e;
      }
    },
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
    // Emisión. Por defecto CRI usa la empresa 'main' de la cuenta y NO hace falta
    // idCompany. Pero una cuenta puede tener además empresas ASOCIADAS (varios
    // emisores bajo el mismo token): para emitir con una de ellas hay que indicar
    // `idCompany`, igual que ya se hace al consultar el documento. Solo se manda
    // cuando `asCompany` viene en true, para no alterar el flujo de la principal.
    emitDocument: (
      kind: 'invoice' | 'ticket' | 'credit-note' | 'debit-note',
      _payload: Record<string, any>,
      _companyId?: string,
      opts?: { asCompany?: boolean },
    ) => {
      const useCompany = opts?.asCompany && _companyId;
      const path = useCompany
        ? `${EMIT_PATH[kind]}?idCompany=${encodeURIComponent(String(_companyId))}`
        : EMIT_PATH[kind];
      // Se manda también por header: Alanube acepta ambas formas según el recurso.
      const headers = useCompany
        ? { idCompany: String(_companyId), 'X-Company-Id': String(_companyId) }
        : undefined;
      return f(path, { method: 'POST', body: JSON.stringify(_payload), headers });
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
      // idCompany: OBLIGATORIO para empresas 'associated' (si no, Alanube responde
      // "document not found"). ?documents=xml,xmlHacienda,pdf trae los archivos.
      const params = new URLSearchParams();
      if (opts?.documents) params.set('documents', opts.documents);
      if (opts?.companyId) params.set('idCompany', String(opts.companyId));
      const qs = params.toString() ? `?${params.toString()}` : '';
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
    // ── Reportes de emisión (a nivel de cuenta/token) ──────────────────────────
    // Devuelven el CONTEO de documentos por tipo (facturas, tiquetes, notas, etc.)
    // en un rango de fechas. dateFrom/dateUntil son OBLIGATORIOS (YYYY-MM-DD).
    reportEmissionsPerCompany: (from: string, until: string, opts?: { legalStatus?: string; status?: string }) => {
      const qs = new URLSearchParams({ dateFrom: from, dateUntil: until });
      if (opts?.legalStatus) qs.set('legalStatus', opts.legalStatus);
      if (opts?.status) qs.set('status', opts.status);
      // Los reportes recorren TODOS los documentos del rango, así que tardan más
      // que una emisión. El tope son 25 s a propósito: la función de Vercel muere
      // a los 30 s (vercel.json), y conviene cortar ANTES para poder devolver un
      // mensaje que explique qué pasó en vez del 504 pelado de la plataforma.
      /**
       * 22 segundos: lo que Alanube necesita de verdad para estos reportes.
       *
       * El techo real es el servidor, que muere a los 30 s. Por eso lo que se
       * arregló NO fue acortar la espera —12 s no le alcanzaban ni a Alanube— sino
       * que todas las cuentas se consulten A LA VEZ: así el reporte tarda lo que
       * tarda la cuenta más lenta, no la suma de todas.
       */
      return f(`/reports/emissions-per-company?${qs.toString()}`, { method: 'GET', timeoutMs: 22_000 });
    },
    reportEmissionsByUser: (from: string, until: string, legalStatus: string) => {
      const qs = new URLSearchParams({ dateFrom: from, dateUntil: until, legalStatus });
      return f(`/reports/emissions-by-user?${qs.toString()}`, { method: 'GET', timeoutMs: 22_000 });
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
  /** Cliente para el ambiente de un tenant: alanube.forEnv(cfg.environment).
   *  El 2º parámetro permite usar el token PROPIO del negocio (cuenta aparte). */
  forEnv: (env?: string | null, token?: string | null): AlanubeClient => clientFor(resolveEnv(env), token),
  /** Cliente a partir de la config FE del tenant: usa su token propio si lo tiene. */
  forTenant: (cfg: any): AlanubeClient => {
    const env = resolveEnv(cfg?.environment);
    return clientFor(env, tenantAlanubeToken(cfg, env));
  },
};
