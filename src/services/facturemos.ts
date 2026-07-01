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

function getApiKeyCliente(): string {
  const key = process.env.FACTUREMOS_API_KEY_CLIENTE;
  if (!key) {
    throw new FacturemosError(
      'Falta FACTUREMOS_API_KEY_CLIENTE en el servidor. Configurá la variable de entorno.',
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
    body: JSON.stringify({ ApiKeyCliente: getApiKeyCliente() }),
  }).catch((err) => { throw new FacturemosError(`No se pudo conectar con Facturemos: ${err.message}`); });

  const body: any = await res.json().catch(() => ({}));
  // La API responde { Response, CurrentException, Status }. Status 0 = éxito.
  if (!res.ok || body?.Status === 1 || !body?.Response) {
    throw new FacturemosError(
      body?.CurrentException || `Facturemos respondió ${res.status} al obtener token`,
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
  }).catch((err) => { throw new FacturemosError(`No se pudo conectar con Facturemos: ${err.message}`); });

  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.Status === 1) {
    throw new FacturemosError(
      body?.CurrentException || `Facturemos respondió ${res.status} al consultar estatus`,
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
  }).catch((err) => { throw new FacturemosError(`No se pudo conectar con Facturemos: ${err.message}`); });

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
