/**
 * Pasarela de Facturación Electrónica para apps EXTERNAS (Costa Rica / Alanube).
 *
 * Motivación: apps que no viven en la base de NovaPOS (ej. JKM, que corre sobre su
 * propio proyecto de Supabase) necesitan emitir a Hacienda, pero el token de
 * Alanube es secreto y no puede estar en el navegador. Este router expone el
 * MISMO motor de emisión (`buildAlanubeDocument` + `alanube`) de forma
 * COMPLETAMENTE SIN ESTADO: recibe el documento armado en el body, lo emite y
 * devuelve la clave/estado. No lee ni escribe NADA en la base de NovaPOS — el
 * cliente guarda el resultado en su propia base.
 *
 * Diferencias con /hacienda (el router del POS):
 *  · /hacienda parte de un `invoice_id` de la tabla `invoices` y de la config del
 *    tenant en `settings`; acá todo viene en el request.
 *  · /hacienda autentica con el JWT de Supabase de NovaPOS y resuelve `tenantId`;
 *    acá se valida el JWT del proyecto Supabase de la app externa.
 *
 * Autenticación: `Authorization: Bearer <access_token de la app externa>`. Se
 * verifica contra `FE_EXTERNAL_SUPABASE_URL/auth/v1/user`, así NO hace falta
 * ningún secreto compartido en el bundle del frontend. Opcionalmente se limita
 * por correo con `FE_EXTERNAL_ALLOWED_EMAILS`.
 *
 * Variables de entorno:
 *  · FE_EXTERNAL_SUPABASE_URL       URL del proyecto Supabase de la app externa
 *  · FE_EXTERNAL_SUPABASE_ANON_KEY  anon key de ese proyecto (para /auth/v1/user)
 *  · FE_EXTERNAL_ALLOWED_EMAILS     (opcional) lista de correos autorizados
 *  · ALANUBE_API_TOKEN_SANDBOX / ALANUBE_API_TOKEN_PRODUCTION (ya existentes)
 *  · FRONTEND_URL                   debe incluir el origen de la app externa (CORS)
 */
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { ok, fail } from '../utils/response.js';
import { alanube, AlanubeError } from '../services/alanube.js';
import { buildAlanubeDocument, type AlanubeEmisor, type AlanubeReceptor } from '../services/alanubeDocument.js';
import type { FELine } from '../services/feDocument.js';
import { alanubeDocStatus, friendlyAlanubeError } from './hacienda.js';
import { sendEmail, emailEnabled } from '../services/emailService.js';

type Variables = { feUserEmail: string };

const feExternal = new Hono<{ Variables: Variables }>();

/** Valida el JWT del proyecto Supabase de la app externa. */
const requireExternalUser = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const url  = (process.env.FE_EXTERNAL_SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const anon = (process.env.FE_EXTERNAL_SUPABASE_ANON_KEY ?? '').trim();
  if (!url || !anon) {
    return fail(c, 'La pasarela de FE externa no está configurada en el servidor (FE_EXTERNAL_SUPABASE_URL / FE_EXTERNAL_SUPABASE_ANON_KEY).', 500);
  }

  const token = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return fail(c, 'No autorizado: falta el token de sesión.', 401);

  let user: any;
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return fail(c, 'Token inválido o expirado. Volvé a iniciar sesión.', 401);
    user = await res.json();
  } catch (err: any) {
    return fail(c, `No se pudo validar la sesión: ${err?.message ?? 'error de red'}`, 502);
  }

  const email = String(user?.email ?? '').trim().toLowerCase();
  if (!user?.id) return fail(c, 'Token inválido: sin usuario.', 401);

  // Lista blanca opcional de correos con permiso para emitir.
  const allowed = (process.env.FE_EXTERNAL_ALLOWED_EMAILS ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(email)) {
    return fail(c, 'Tu usuario no tiene permiso para emitir comprobantes electrónicos.', 403);
  }

  c.set('feUserEmail', email);
  await next();
});

feExternal.use('*', requireExternalUser);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Igual que en /hacienda: busca en profundidad la primera clave que matchee. */
function deepFind(obj: any, re: RegExp, minLen = 1): string | null {
  const seen = new Set<any>();
  const walk = (o: any): string | null => {
    if (!o || typeof o !== 'object' || seen.has(o)) return null;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      if (re.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length >= minLen) {
        return String(v);
      }
    }
    for (const v of Object.values(o)) { const r = walk(v); if (r) return r; }
    return null;
  };
  return walk(obj);
}

/** tipo de comprobante Hacienda → recurso de Alanube. */
function kindOfTipoDoc(tipoDoc: string): 'invoice' | 'ticket' | 'credit-note' | 'debit-note' {
  switch (String(tipoDoc)) {
    case '01': return 'invoice';
    case '03': return 'credit-note';
    case '02': return 'debit-note';
    default:   return 'ticket';   // 04 tiquete
  }
}

/** Normaliza `document_type` (nombre o código) al código Hacienda. */
function tipoDocOf(documentType?: string | null): string {
  const s = String(documentType ?? '').trim().toLowerCase();
  if (s === '01' || s === 'factura_electronica' || s === 'factura') return '01';
  if (s === '03' || s === 'nota_credito') return '03';
  if (s === '02' || s === 'nota_debito')  return '02';
  return '04';   // tiquete_electronico (default)
}

const num = (v: any) => Number(v ?? 0) || 0;

/** Normaliza las líneas del body al tipo FELine que espera el constructor. */
function normalizeLines(raw: any): FELine[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((l: any) => {
    const quantity  = num(l.quantity ?? l.cantidad);
    const unitPrice = num(l.unit_price ?? l.precio_unitario ?? l.precio_venta);
    // subtotal = monto de la línea SIN impuesto (con descuentos ya aplicados).
    const subtotal  = l.subtotal != null ? num(l.subtotal) : quantity * unitPrice;
    return {
      product_name: String(l.product_name ?? l.nombre ?? l.detalle ?? '').trim(),
      sku:          l.sku ?? l.codigo ?? null,
      quantity,
      unit_price:   unitPrice,
      subtotal,
      cabys_code:   String(l.cabys_code ?? l.cabys ?? '').replace(/\D/g, '') || null,
      iva_rate:     num(l.iva_rate ?? l.impuesto ?? 0),
      unit:         l.unit ?? l.unidad ?? l.medida ?? null,
    } as FELine;
  }).filter(l => l.quantity > 0 && l.product_name);
}

/** Ambiente + empresa emisora, tal como los manda la app externa. */
function envAndCompany(body: any): { environment: string; companyId: string } {
  return {
    environment: alanube.normalizeEnv(body?.environment),
    companyId:   String(body?.company_id ?? body?.alanube_company_id ?? '').trim(),
  };
}

// ── GET /ping — diagnóstico: sesión válida y tokens de Alanube cargados ───────
feExternal.get('/ping', (c) => ok(c, {
  ok: true,
  user: c.get('feUserEmail'),
  default_environment: alanube.defaultEnv(),
  tokens: {
    sandbox:    !!(process.env.ALANUBE_API_TOKEN_SANDBOX || process.env.ALANUBE_API_TOKEN),
    production: !!process.env.ALANUBE_API_TOKEN_PRODUCTION,
  },
}));

// ── POST /test-connection — verifica token + empresa emisora, sin emitir nada ─
// body: { environment, company_id? }
feExternal.post('/test-connection', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const { environment, companyId } = envAndCompany(body);
  try {
    const client = alanube.forEnv(environment);
    // Con id → la empresa concreta (puede ser 'associated'); sin id → la 'main' del token.
    const company: any = companyId ? await client.getCompany(companyId) : await client.getMainCompany();
    const co = company?.company ?? company?.data ?? company;
    return ok(c, {
      ok: true,
      environment,
      base_url: client.baseUrl(),
      company: {
        id:   co?.id ?? companyId ?? null,
        name: co?.name ?? co?.legalName ?? co?.businessName ?? null,
        identification: co?.identification?.identificationNumber ?? co?.identification ?? null,
      },
    });
  } catch (err: any) {
    const status = err instanceof AlanubeError ? err.status : 502;
    return fail(c, err instanceof AlanubeError ? friendlyAlanubeError(err.message) : (err?.message ?? 'Error consultando Alanube'), status);
  }
});

// ── POST /company — da de alta (o actualiza) la empresa emisora en Alanube ────
//
// Es el paso previo a poder emitir: Alanube necesita el certificado de firma
// (.p12 que emite Hacienda) con su PIN, y las credenciales de API generadas en
// ATV. Devuelve el id de la empresa, que el cliente guarda en su config.
//
// El .p12 llega en base64 y NO se persiste en ningún lado: se reenvía a Alanube,
// que es quien lo custodia y firma con él.
//
// body: {
//   environment, company_type?,
//   emisor: { name, identification_type, identification, commercial_name?,
//             economic_activity_code, email, phone?,
//             province_code, canton_code, district_code, address },
//   certificate: { content_base64, password },
//   atv: { username, password }
// }
feExternal.post('/company', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const environment = alanube.normalizeEnv(body?.environment);
  const e = body?.emisor ?? {};
  const cert = body?.certificate ?? {};
  const atv = body?.atv ?? {};

  // Normalización de códigos de ubicación de Hacienda: provincia 1 dígito (1-7),
  // cantón/distrito 2 dígitos. Si no coinciden con Tributación, se rechaza (-37).
  const provDigit = (s: any) => (String(s ?? '').replace(/\D/g, '').replace(/^0+/, '') || '').slice(0, 1);
  const pad2Code  = (s: any) => { const d = String(s ?? '').replace(/\D/g, ''); return d ? d.padStart(2, '0').slice(-2) : ''; };

  // ── Validación completa ANTES de llamar a Alanube: se devuelven TODOS los
  // problemas juntos para que el usuario sepa exactamente qué corregir.
  const problemas: string[] = [];
  const nombre = String(e.name ?? '').trim();
  if (!nombre) problemas.push('Nombre / razón social del emisor: vacío.');

  const idType = String(e.identification_type ?? '').trim();
  if (!['01', '02', '03', '04'].includes(idType)) {
    problemas.push(`Tipo de identificación inválido ("${idType || 'vacío'}"): debe ser 01 (física), 02 (jurídica), 03 (DIMEX) o 04 (NITE).`);
  }
  const cedula = String(e.identification ?? '').replace(/\D/g, '');
  if (!cedula) problemas.push('Número de identificación (cédula) del emisor: vacío.');
  else {
    const largos: Record<string, number[]> = { '01': [9], '02': [10], '03': [11, 12], '04': [10] };
    if (idType && largos[idType] && !largos[idType].includes(cedula.length)) {
      problemas.push(`La cédula "${cedula}" tiene ${cedula.length} dígitos y no coincide con el tipo ${idType} (física=9, jurídica=10, DIMEX=11-12, NITE=10).`);
    }
  }

  const provincia = provDigit(e.province_code);
  if (!/^[1-7]$/.test(provincia)) problemas.push('Provincia: falta o es inválida (1 a 7).');
  const canton = pad2Code(e.canton_code);
  if (!/^\d{2}$/.test(canton)) problemas.push('Cantón: falta o es inválido (2 dígitos).');
  const distrito = pad2Code(e.district_code);
  if (!/^\d{2}$/.test(distrito)) problemas.push('Distrito: falta o es inválido (2 dígitos).');
  const otrasSenas = String(e.address ?? '').trim();
  if (!otrasSenas) problemas.push('Otras señas (dirección exacta): vacío.');

  const actividad = String(e.economic_activity_code ?? '').trim();
  if (!actividad) problemas.push('Actividad económica: vacía (el código lo asigna Hacienda).');

  const email = String(e.email ?? '').trim();
  if (!email) problemas.push('Correo del emisor: vacío.');
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problemas.push(`Correo del emisor inválido: "${email}".`);

  const p12 = String(cert.content_base64 ?? '').replace(/^data:.*?;base64,/, '').trim();
  if (!p12) problemas.push('Certificado .p12: falta el archivo.');
  const p12Pass = String(cert.password ?? '');
  if (!p12Pass) problemas.push('PIN / contraseña del certificado .p12: vacío.');

  const atvUser = String(atv.username ?? '').trim();
  const atvPass = String(atv.password ?? '');
  if (!atvUser) problemas.push('Usuario de API de ATV: vacío.');
  if (!atvPass) problemas.push('Contraseña de API de ATV: vacía.');

  if (problemas.length > 0) {
    return fail(c, 'No se puede registrar la empresa en Alanube — revisá estos datos:\n• ' + problemas.join('\n• '), 422);
  }

  const client = alanube.forEnv(environment);

  const payload: Record<string, any> = {
    name: nombre,
    identificationType: idType,
    identificationNumber: cedula,
    // En CRI la emisión usa SIEMPRE la empresa 'main' de la cuenta (no hay
    // parámetro idCompany al emitir), así que el emisor se crea como 'main'.
    type: body?.company_type === 'associated' ? 'associated' : 'main',
    address: { province: provincia, canton, district: distrito, otrasSenas },
    // Certificado de firma (.p12) + su PIN.
    certificate: { extension: 'p12', content: p12, password: p12Pass },
    // Credenciales de API generadas en ATV (son distintas por ambiente).
    token: { username: atvUser, password: atvPass },
    economicActivities: [actividad],
    emails: [email],
  };
  if (e.commercial_name) payload.tradeName = String(e.commercial_name).trim();
  const phone = String(e.phone ?? '').replace(/\D/g, '');
  if (phone) payload.phone = { countryCode: '506', phoneNumber: phone };

  /** Busca el id de la empresa en la respuesta de Alanube (el nombre varía). */
  const findCompanyId = (result: any): string | null => {
    if (!result || typeof result !== 'object') return null;
    const direct = result.id ?? result.companyId ?? result.company?.id
      ?? result.data?.id ?? result.data?.companyId ?? result.data?.company?.id ?? result._id;
    if (direct) return String(direct);
    return deepFind(result, /(^id$|_id$|Id$)/, 6);
  };

  let result: any;
  let actualizada = false;

  try {
    result = await client.createCompany(payload);
  } catch (err: any) {
    const yaExiste = err instanceof AlanubeError
      && (err.status === 400 || err.status === 409)
      && /already has (a )?main company|ya tiene.*empresa|main company/i.test(String(err?.message ?? ''));

    if (!yaExiste) {
      const status = err instanceof AlanubeError ? (err.status === 401 ? 401 : 422) : 502;
      return fail(c, err instanceof AlanubeError ? friendlyAlanubeError(err.message) : (err?.message ?? 'Error registrando la empresa en Alanube'), status);
    }

    // La cuenta ya tiene su empresa principal: ubicamos su id y la ACTUALIZAMOS,
    // así reintentar el registro es idempotente (sirve para renovar el .p12).
    let existingId: string | null = null;

    // 1) El cuerpo del error 400/409 suele traer el id de la empresa existente.
    const delError = findCompanyId((err as any)?.body);
    if (delError) {
      try {
        const co: any = await client.getCompany(String(delError));
        if (findCompanyId(co?.company ?? co)) existingId = String(delError);
      } catch { /* el id del error no vale en este ambiente → seguir */ }
    }
    // 2) El id que el cliente ya tuviera guardado.
    if (!existingId && body?.company_id) {
      try {
        const co: any = await client.getCompany(String(body.company_id));
        if (findCompanyId(co?.company ?? co)) existingId = String(body.company_id);
      } catch { /* no existe acá → seguir */ }
    }
    // 3) La empresa 'main' del token.
    if (!existingId) {
      try {
        const co: any = await client.getMainCompany();
        existingId = findCompanyId(co?.company ?? co);
      } catch { /* CRI no siempre expone /company → seguir */ }
    }
    // 4) Respaldo: por cédula entre las empresas asociadas.
    if (!existingId) {
      try {
        const list: any = await client.getAssociated(100);
        const arr: any[] = Array.isArray(list) ? list : (list?.data ?? list?.companies ?? list?.results ?? list?.rows ?? []);
        const co = (arr ?? []).find((x: any) =>
          String(x?.identificationNumber ?? x?.identification?.identificationNumber ?? '').replace(/\D/g, '') === cedula);
        if (co) existingId = findCompanyId(co);
      } catch { /* sin lista de asociadas */ }
    }

    if (!existingId) {
      // No se pudo ubicar el id, pero la empresa principal EXISTE y la emisión la
      // usa automáticamente. No es un error que bloquee.
      return ok(c, {
        ok: true,
        already_main: true,
        environment: client.env,
        company_id: null,
        message: 'La empresa principal ya existe en esta cuenta de Alanube y podés emitir con ella. '
          + 'No se pudo recuperar su ID por API: copialo del panel de Alanube y pegalo en la configuración.',
        response: (err as any)?.body ?? null,
      });
    }

    const updPayload = { ...payload };
    delete (updPayload as any).type;   // 'type' solo se define al crear
    try {
      result = await client.updateCompany(String(existingId), updPayload);
    } catch (err2: any) {
      const status = err2 instanceof AlanubeError ? (err2.status === 401 ? 401 : 422) : 502;
      return fail(c, err2 instanceof AlanubeError ? friendlyAlanubeError(err2.message) : (err2?.message ?? 'Error actualizando la empresa en Alanube'), status);
    }
    if (!findCompanyId(result)) result = { ...result, id: existingId };
    actualizada = true;
  }

  const companyId = findCompanyId(result);
  return ok(c, {
    ok: true,
    environment: client.env,
    company_id: companyId,
    updated_existing: actualizada,
    message: actualizada
      ? 'La empresa ya existía en Alanube y se actualizó con estos datos y este certificado.'
      : 'Empresa registrada en Alanube. Ya podés emitir comprobantes.',
    response: result,
  });
});

// ── POST /emit — emite un tiquete (04) o factura (01) electrónica ─────────────
// body: {
//   environment, company_id, document_type, number, headquarters?, terminal?,
//   payment_method, emisor:{...}, receptor:{...}|null, lines:[...], debug?
// }
feExternal.post('/emit', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const { environment, companyId } = envAndCompany(body);
  const debug = body?.debug === true;

  if (!companyId) {
    return fail(c, 'Falta company_id: el id de la empresa emisora en Alanube para este ambiente.', 422);
  }

  // ── Emisor ────────────────────────────────────────────────────────────────
  const e = body?.emisor ?? {};
  const emisor: AlanubeEmisor = {
    identification_type:    String(e.identification_type ?? '02'),
    identification:         String(e.identification ?? '').replace(/\D/g, ''),
    name:                   String(e.name ?? '').trim(),
    commercial_name:        e.commercial_name ?? '',
    economic_activity_code: String(e.economic_activity_code ?? '').trim(),
  };
  if (!emisor.identification) return fail(c, 'Falta la cédula del emisor en los datos de facturación electrónica.', 422);
  if (!emisor.name)           return fail(c, 'Falta el nombre/razón social del emisor.', 422);
  if (!emisor.economic_activity_code) {
    return fail(c, 'Falta el código de actividad económica del emisor (lo asigna Hacienda al inscribirse).', 422);
  }

  // ── Líneas ────────────────────────────────────────────────────────────────
  const lines = normalizeLines(body?.lines ?? body?.items);
  if (lines.length === 0) return fail(c, 'El comprobante no tiene líneas de detalle para emitir.', 422);

  // Hacienda exige CodigoCABYS en cada línea. Se avisa con el nombre del producto.
  const sinCabys = lines.filter(l => !l.cabys_code);
  if (sinCabys.length > 0) {
    const nombres = [...new Set(sinCabys.map(l => l.product_name))].join(', ');
    return fail(c, `Estos productos no tienen código CABYS: ${nombres}. Asignáselo en el producto (o configurá un CABYS por defecto).`, 422);
  }

  // ── Receptor ──────────────────────────────────────────────────────────────
  const r = body?.receptor ?? body?.cliente ?? null;
  const receptor: AlanubeReceptor | null = r
    ? {
        name:                r.name ?? r.nombre ?? '',
        identification_type: r.identification_type ?? r.tipo_identificacion ?? undefined,
        identification:      r.identification ?? r.cedula ?? r.identificacion ?? undefined,
        email:               r.email ?? undefined,
        province_code:       r.province_code ?? r.provincia ?? undefined,
        canton_code:         r.canton_code ?? r.canton ?? undefined,
        district_code:       r.district_code ?? r.distrito ?? undefined,
        address:             r.address ?? r.direccion ?? undefined,
      }
    : null;

  const tipoDoc = tipoDocOf(body?.document_type);
  // La Factura Electrónica (01) exige receptor identificado; el tiquete (04) no.
  if (tipoDoc === '01' && !(receptor?.identification && receptor?.identification_type)) {
    return fail(c, 'Para emitir Factura Electrónica el cliente debe tener cédula (identificación) y tipo de identificación. Si no la tiene, emití como tiquete electrónico.', 422);
  }

  // ── Armado del payload CRI (mismo constructor que usa el POS) ─────────────
  const doc = buildAlanubeDocument(
    emisor,
    {
      payment_method: String(body?.payment_method ?? 'cash'),
      issued_at:      body?.issued_at,
    },
    lines,
    receptor,
    {
      tipoDoc,
      headquarters:     body?.headquarters ?? '1',
      terminal:         body?.terminal ?? '1',
      numberOfDocument: String(body?.number ?? body?.numberOfDocument ?? '1'),
      senderId:         companyId,
    },
  );

  // Actividad económica del RECEPTOR (Hacienda v4.4). Solo se agrega si el cliente
  // la tiene, para no alterar el payload de los comprobantes que no la usan.
  const actividadReceptor = String(r?.economic_activity_code ?? r?.actividad_economica ?? '').trim();
  if (actividadReceptor) {
    (doc.header as Record<string, any>).receiverEconomicActivity = actividadReceptor;
  }

  // Modo debug: devuelve lo que se enviaría, sin emitir.
  if (debug) {
    return ok(c, { debug: true, environment, kind: kindOfTipoDoc(tipoDoc), company_id: companyId, tipo: tipoDoc, payload: doc });
  }

  let resp: any;
  try {
    resp = await alanube.forEnv(environment).emitDocument(kindOfTipoDoc(tipoDoc) as any, doc, companyId);
  } catch (err: any) {
    const status = err instanceof AlanubeError ? (err.status === 401 ? 401 : 422) : 502;
    // Se devuelve el JSON enviado para que la app externa lo guarde en su bitácora.
    return c.json({
      data: null,
      error: err instanceof AlanubeError ? friendlyAlanubeError(err.message) : (err?.message ?? 'Error emitiendo con Alanube'),
      request: doc,
    }, status as any);
  }

  // La respuesta viene envuelta según el tipo:
  //   { ticket|invoice|creditNote: { id (ULID), key (clave 50 díg), status } }
  const docObj = resp?.ticket ?? resp?.invoice ?? resp?.creditNote ?? resp?.debitNote ?? resp?.document ?? resp?.data ?? resp;
  const docId  = docObj?.id ?? deepFind(resp, /(^id$|_id$|documentId$)/i, 10) ?? null;
  const clave  = docObj?.key ?? docObj?.clave ?? deepFind(resp, /(clave|^key$)/i, 40) ?? null;

  return ok(c, {
    ok: true,
    provider: 'alanube',
    environment,
    tipo: tipoDoc,
    clave: clave ?? docId,          // preferimos la clave real de Hacienda
    doc_id: docId,                  // id ULID de Alanube (para consultar estado/PDF)
    alanube_status: docObj?.status ?? null,
    request: doc,
    response: resp,
  });
});

// ── GET /status/:docId — estado del documento en Hacienda ─────────────────────
// query: environment, company_id, document_type
feExternal.get('/status/:docId', async (c) => {
  const docId = c.req.param('docId');
  const environment = alanube.normalizeEnv(c.req.query('environment'));
  const companyId = String(c.req.query('company_id') ?? '').trim() || undefined;
  const kind = kindOfTipoDoc(tipoDocOf(c.req.query('document_type')));
  try {
    const r = await alanubeDocStatus(alanube.forEnv(environment), docId, { kind, companyId });
    return ok(c, {
      status: r.status,               // sent | accepted | rejected | error
      raw_status: r.rawStatus,        // legalStatus crudo de Alanube/Hacienda
      clave: r.clave,
      error: r.error,                 // motivo del rechazo, ya legible
      response: r.raw,
    });
  } catch (err: any) {
    const status = err instanceof AlanubeError ? err.status : 502;
    return fail(c, err instanceof AlanubeError ? friendlyAlanubeError(err.message) : (err?.message ?? 'Error consultando el estado'), status);
  }
});

// ── GET /pdf/:docId — PDF del comprobante en base64 ──────────────────────────
// query: environment, company_id (obligatorio), document_type
feExternal.get('/pdf/:docId', async (c) => {
  const docId = c.req.param('docId');
  const environment = alanube.normalizeEnv(c.req.query('environment'));
  const companyId = String(c.req.query('company_id') ?? '').trim();
  if (!companyId) return fail(c, 'Falta company_id para pedir el PDF.', 422);
  const kind = kindOfTipoDoc(tipoDocOf(c.req.query('document_type')));
  try {
    const res: any = await alanube.forEnv(environment).getDocumentPdf(docId, kind, companyId);
    const pdf = res?.pdf ?? res?.file ?? res?.base64 ?? res?.data?.pdf ?? deepFind(res, /(pdf|base64|file)/i, 100);
    if (!pdf) return fail(c, 'Alanube no devolvió el PDF del comprobante.', 404);
    return ok(c, { pdf_base64: String(pdf).replace(/^data:.*?;base64,/, '') });
  } catch (err: any) {
    const status = err instanceof AlanubeError ? err.status : 502;
    return fail(c, err instanceof AlanubeError ? friendlyAlanubeError(err.message) : (err?.message ?? 'Error obteniendo el PDF'), status);
  }
});

// ── Envío del comprobante por correo (Resend) ────────────────────────────────

/** Descarga una URL y la devuelve en base64. null si falla. */
async function fetchToBase64(url: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length ? buf.toString('base64') : null;
  } catch { return null; }
}

/** Valor del comprobante → base64: URL se descarga; XML crudo se codifica;
 *  lo que ya viene en base64 se deja igual. */
async function toB64(v: any): Promise<string | null> {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return await fetchToBase64(s);
  return s.startsWith('<') ? Buffer.from(s, 'utf8').toString('base64') : s;
}

/** Adjuntos del comprobante: XML original, XML de respuesta de Hacienda y PDF.
 *  Tolerante a fallos: devuelve lo que haya podido bajar. */
async function alanubeAttachments(
  environment: string,
  docId: string,
  kind: string,
  clave: string,
  companyId?: string,
): Promise<Array<{ filename: string; content: string }>> {
  const out: Array<{ filename: string; content: string }> = [];
  const client = alanube.forEnv(environment);
  const base = String(clave || docId);

  // Alanube entrega los XML como URL en los campos xml / xmlHacienda.
  try {
    const resp: any = await client.getDocument(docId, { kind: kind as any, companyId, documents: 'xml-xmlHacienda' });
    const d = resp?.invoice ?? resp?.ticket ?? resp?.creditNote ?? resp?.debitNote ?? resp?.document ?? resp?.data ?? resp;
    const xml = await toB64(d?.xml ?? deepFind(resp, /^xml$/i, 8_000_000));
    const xmlHac = await toB64(d?.xmlHacienda ?? deepFind(resp, /xmlhacienda/i, 8_000_000));
    if (xml) out.push({ filename: `${base}.xml`, content: xml });
    if (xmlHac) out.push({ filename: `${base}-respuesta-hacienda.xml`, content: xmlHac });
  } catch (e: any) { console.warn('[FE externa email] XML no disponible:', e?.message); }

  // El PDF va por su endpoint dedicado y necesita idCompany.
  try {
    if (companyId) {
      const r: any = await client.getDocumentPdf(docId, kind, companyId);
      const pdf = await toB64(r?.pdf ?? deepFind(r, /^pdf$/i, 12_000_000));
      if (pdf) out.push({ filename: `${base}.pdf`, content: pdf });
    }
  } catch (e: any) { console.warn('[FE externa email] PDF no disponible:', e?.message); }

  return out;
}

// POST /send-email — manda el comprobante al cliente con XML + PDF adjuntos.
// body: {
//   environment, company_id, doc_id, document_type, clave,
//   to, numero?, cliente_nombre?, total?, estado?, negocio?
// }
feExternal.post('/send-email', async (c) => {
  if (!emailEnabled()) {
    return fail(c, 'El envío de correos no está configurado en el servidor (falta RESEND_API_KEY).', 500);
  }

  const body = await c.req.json().catch(() => ({} as any));
  const to = String(body?.to ?? '').trim();
  const docId = String(body?.doc_id ?? '').trim();
  const clave = String(body?.clave ?? '').trim();

  if (!to) return fail(c, 'Falta el correo del cliente.', 422);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return fail(c, `El correo "${to}" no tiene un formato válido.`, 422);
  if (!docId) return fail(c, 'Falta doc_id: el comprobante no fue emitido todavía.', 422);

  const environment = alanube.normalizeEnv(body?.environment);
  const companyId = String(body?.company_id ?? '').trim() || undefined;
  const kind = kindOfTipoDoc(tipoDocOf(body?.document_type));

  const attachments = await alanubeAttachments(environment, docId, kind, clave, companyId);

  const negocio = String(body?.negocio ?? 'Comprobante electrónico').trim();
  const numero = String(body?.numero ?? (clave || docId));
  const estadoTexto = body?.estado === 'accepted' ? 'Aceptado por Hacienda'
    : body?.estado === 'rejected' ? 'Rechazado por Hacienda'
    : 'En proceso en Hacienda';

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827">
      <h2 style="margin:0 0 16px">Comprobante electrónico ${numero}</h2>
      <p style="margin:4px 0"><b>Emisor:</b> ${negocio}</p>
      <p style="margin:4px 0"><b>Cliente:</b> ${body?.cliente_nombre ?? '—'}</p>
      <p style="margin:4px 0"><b>Estado:</b> ${estadoTexto}</p>
      <p style="margin:4px 0"><b>Clave:</b> <span style="font-family:monospace;font-size:12px">${clave || '—'}</span></p>
      <p style="margin:4px 0"><b>Total:</b> ₡${Number(body?.total ?? 0).toLocaleString('es-CR')}</p>
      ${attachments.length
        ? '<p style="margin-top:16px;color:#4b5563">Se adjuntan el XML del comprobante, la respuesta de Hacienda y el PDF.</p>'
        : '<p style="margin-top:16px;color:#b45309">Los archivos del comprobante todavía no están disponibles en Hacienda; se pueden solicitar más tarde.</p>'}
    </div>`;

  try {
    const { id } = await sendEmail({
      to,
      subject: `Comprobante electrónico ${numero} — ${negocio}`,
      html,
      attachments: attachments.length ? attachments : undefined,
    });
    return ok(c, { ok: true, email_id: id, attachments: attachments.length });
  } catch (err: any) {
    return fail(c, `No se pudo enviar el correo: ${err?.message ?? 'error desconocido'}`, 502);
  }
});

export default feExternal;
