/**
 * Cliente de la API de Facturación Electrónica Facturemos CR.
 *
 * Modelo de seguridad:
 *  - ApiKeyCliente = secreto MAESTRO. Vive SOLO en el backend, vía variable de
 *    entorno FACTUREMOS_API_KEY_CLIENTE. Nunca se expone al frontend ni se guarda
 *    por tenant.
 *  - ApiKeyEmisor = clave por emisor (negocio). Se guarda en la config de FE del
 *    tenant y se envía en el body de cada documento (lo maneja cada ruta).
 *
 * Fase 1: solo autenticación (obtener token con cache) + consulta de estatus.
 * La emisión de documentos se implementa en fases siguientes.
 */

const BASE_URLS: Record<string, string> = {
  sandbox:    'https://api-qa.facturemoscr.com',
  production: 'https://api.facturemoscr.com',
};

type Env = 'sandbox' | 'production';

function baseUrl(env: string): string {
  return BASE_URLS[env] ?? BASE_URLS.sandbox;
}

/** Decodifica el `exp` (epoch en segundos) de un JWT sin verificar la firma. */
function jwtExp(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload, 'base64').toString('utf8');
    const exp = JSON.parse(json)?.exp;
    return typeof exp === 'number' ? exp : null;
  } catch { return null; }
}

// Cache de token en memoria por ambiente (el ApiKeyCliente es uno solo).
const tokenCache = new Map<Env, { token: string; expiresAt: number }>();

export class FacturemosError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

/** Error de red al llamar a Facturemos. Expone la causa real (undici la pone en
 *  `err.cause`: ENOTFOUND=DNS, ECONNREFUSED=puerto cerrado, ETIMEDOUT/UND_ERR_CONNECT_TIMEOUT=timeout,
 *  CERT_*=TLS). Así "fetch failed" deja de ser opaco. */
function connError(env: string, err: any): FacturemosError {
  const cause = err?.cause;
  const detail = cause?.code || cause?.message || err?.message || 'fetch failed';
  return new FacturemosError(
    `No se pudo conectar con Facturemos (ambiente "${env}", ${baseUrl(env)}): ${detail}. ` +
    `Revisá conectividad de red/DNS/firewall del servidor hacia Facturemos.`,
  );
}

// Clave MAESTRA del cliente, por ambiente. QA y producción de Facturemos usan
// credenciales maestras distintas, así que se puede configurar una por ambiente:
//   - producción: FACTUREMOS_API_KEY_CLIENTE_PRODUCTION (o la legacy FACTUREMOS_API_KEY_CLIENTE)
//   - sandbox/QA: FACTUREMOS_API_KEY_CLIENTE_SANDBOX     (o la legacy)
function getApiKeyCliente(env: Env): string {
  const legacy = process.env.FACTUREMOS_API_KEY_CLIENTE;
  const key = env === 'sandbox'
    ? (process.env.FACTUREMOS_API_KEY_CLIENTE_SANDBOX || legacy)
    : (process.env.FACTUREMOS_API_KEY_CLIENTE_PRODUCTION || legacy);
  if (!key) {
    throw new FacturemosError(
      `Falta la ApiKey maestra del servidor para ambiente "${env}". Configurá ` +
      (env === 'sandbox' ? 'FACTUREMOS_API_KEY_CLIENTE_SANDBOX' : 'FACTUREMOS_API_KEY_CLIENTE_PRODUCTION') +
      ' (o FACTUREMOS_API_KEY_CLIENTE).',
      500,
    );
  }
  return key;
}

/**
 * Obtiene un token JWT de Facturemos (con cache hasta ~1 min antes de expirar).
 */
export async function obtenerToken(env: string = 'sandbox'): Promise<string> {
  const e = (env === 'production' ? 'production' : 'sandbox') as Env;
  const now = Math.floor(Date.now() / 1000);

  const cached = tokenCache.get(e);
  if (cached && cached.expiresAt - 60 > now) return cached.token;

  const res = await fetch(`${baseUrl(e)}/api/Token/ObtenerToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ApiKeyCliente: getApiKeyCliente(e) }),
  }).catch((err) => { throw connError(env, err); });

  const body: any = await res.json().catch(() => ({}));
  // La API responde { Response, CurrentException, Status }. Status 0 = éxito.
  if (!res.ok || body?.Status === 1 || !body?.Response) {
    throw new FacturemosError(
      `Facturemos rechazó la autenticación del servidor en ambiente "${e}". ` +
      `Verificá la ApiKey maestra del ambiente y que el negocio esté en el ambiente correcto. ` +
      `(${body?.CurrentException || `HTTP ${res.status}`})`,
      res.status === 409 ? 401 : 502,
    );
  }

  const token: string = body.Response;
  const exp = jwtExp(token) ?? now + 30 * 60; // fallback: 30 min
  tokenCache.set(e, { token, expiresAt: exp });
  return token;
}

/**
 * Consulta el estatus de un documento por su clave numérica (50 dígitos).
 */
export async function consultaEstatus(
  env: string,
  apiKeyEmisor: string,
  claveDocumento: string,
): Promise<any> {
  const token = await obtenerToken(env);
  const res = await fetch(`${baseUrl(env)}/api/FacturacionExterna/ConsultaEstatus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ApiKeyEmisor: apiKeyEmisor, ClaveDocumento: claveDocumento }),
  }).catch((err) => { throw connError(env, err); });

  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.Status === 1) {
    const exc = String(body?.CurrentException ?? '');
    // Hacienda procesa de forma ASÍNCRONA: justo después de emitir, la consulta
    // suele responder "no ha sido recibido" / "en proceso". No es un error: es
    // que todavía no terminó de procesarse. Lo devolvemos como PENDIENTE.
    if (/no ha sido recibido|no recibido|en proceso|procesando|procesand|a[uú]n no/i.test(exc)) {
      return { Ind_estado: 'procesando', pending: true, message: exc };
    }
    throw new FacturemosError(
      exc || `Facturemos respondió ${res.status} al consultar estatus`,
      res.status,
    );
  }
  return body?.Response ?? null;
}

export interface ConsecutivoModel {
  Sucursal: string;            // 3 díg
  Terminal: string;            // 5 díg
  TipoComprobante: string;     // 01 factura, 03 NC, 04 tiquete...
  ConsecutivoInterno: string;  // 10 díg
  SituacionDelComprobante: string; // 1 normal, 2 contingencia, 3 sin internet
}

/**
 * Envía un documento electrónico (JSON) con consecutivo administrado por nosotros.
 * Devuelve el Response de Facturemos (suele incluir la Clave asignada).
 */
export async function enviaDocumentoConsecutivoJson(
  env: string,
  apiKeyEmisor: string,
  facturaJson: string,
  consecutivo: ConsecutivoModel,
): Promise<any> {
  const token = await obtenerToken(env);
  const res = await fetch(`${baseUrl(env)}/api/FacturacionExterna/EnviaDocumentoConsecutivoJson`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      FacturaModel: { ApiKeyEmisor: apiKeyEmisor, Factura: facturaJson },
      ConsecutivoModel: consecutivo,
    }),
  }).catch((err) => { throw connError(env, err); });

  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.Status === 1) {
    throw new FacturemosError(
      body?.CurrentException || `Facturemos respondió ${res.status} al enviar el documento`,
      res.status,
    );
  }
  return body?.Response ?? body;
}

/** Limpia el cache de token (útil al rotar la ApiKeyCliente). */
export function clearTokenCache() { tokenCache.clear(); }
