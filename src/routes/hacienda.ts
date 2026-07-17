import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { obtenerToken, consultaEstatus, enviaDocumentoConsecutivoJson, FacturemosError } from '../services/facturemos.js';
import { buildConsecutivo, buildDocumentoJson, tipoComprobante, type FELine } from '../services/feDocument.js';
import { alanube, AlanubeError } from '../services/alanube.js';
import { buildAlanubeDocument } from '../services/alanubeDocument.js';
import { endOfDay } from '../utils/dateRange.js';
import { sendEmail } from '../services/emailService.js';
import { parseHaciendaXml } from '../services/receivedEmails.js';

// Próximo consecutivo de orden de compra (mismo formato que el POS: PO-XXXX).
async function nextPurchaseNumber(tenantId: string): Promise<string> {
  const { data } = await db.from('purchases').select('purchase_number').eq('tenant_id', tenantId).limit(5000);
  let max = 0;
  for (const r of (data ?? []) as any[]) {
    const suffix = String(r.purchase_number ?? '').split('-').pop();
    const n = suffix ? parseInt(suffix, 10) : NaN;
    if (!isNaN(n) && n > max) max = n;
  }
  return `PO-${String(max + 1).padStart(4, '0')}`;
}

// Líneas de un recibido: usa raw.lines / items; si faltan pero hay XML, re-parsea.
function linesFromDoc(d: any): any[] {
  let lines = Array.isArray(d.raw?.lines) ? d.raw.lines : (Array.isArray(d.items) ? d.items : []);
  if ((!lines || lines.length === 0) && d.xml) {
    const parsed = parseHaciendaXml(String(d.xml));
    if (parsed?.lines?.length) lines = parsed.lines;
  }
  return lines ?? [];
}

// Empareja líneas del comprobante con productos del tenant (por CABYS o nombre).
async function matchLines(tenantId: string, lines: any[]): Promise<any[]> {
  const { data: products } = await db.from('products')
    .select('id, name, cabys_code').eq('tenant_id', tenantId).limit(5000);
  const byCabys = new Map<string, any>(), byName = new Map<string, any>();
  for (const p of (products ?? []) as any[]) {
    if (p.cabys_code) byCabys.set(String(p.cabys_code), p);
    if (p.name) byName.set(String(p.name).trim().toLowerCase(), p);
  }
  return lines.map((l: any) => {
    const cabys = String(l.cabys ?? l.CodigoCABYS ?? '');
    const detail = String(l.detail ?? l.Detalle ?? '');
    // Coincidencia PRIMERO por CÓDIGO CABYS (igual al producto interno); si no,
    // por nombre. Si el código no coincide → se crea como nuevo.
    const byCode = cabys ? byCabys.get(cabys) : null;
    const byNombre = byCode ? null : byName.get(detail.trim().toLowerCase());
    const match = byCode || byNombre || null;
    return {
      detail,
      quantity: Number(l.quantity ?? l.Cantidad ?? 1),
      unit_price: Number(l.unit_price ?? l.PrecioUnitario ?? 0),
      total: Number(l.total ?? l.subtotal ?? l.SubTotal ?? 0),
      cabys: cabys || null,
      code: String(l.code ?? l.Codigo ?? '').trim() || null,   // código comercial del XML
      product_id: match?.id ?? null,
      product_name: match?.name ?? null,
      exists: !!match,
      matched_by: byCode ? 'cabys' : byNombre ? 'name' : null,   // cómo coincidió
    };
  });
}

// SKU autogenerado para productos creados desde la recepción (la columna sku es
// NOT NULL). Formato legible + sufijo aleatorio para no chocar.
function genReceptionSku(detail: string): string {
  const base = String(detail || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase() || 'PROD';
  const rnd = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `REC-${base}-${rnd}`;
}

const hacienda = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/** Busca en profundidad el primer valor string/number cuya clave matchea `re`
 *  y cuyo largo ≥ minLen. Sirve para leer id/clave sin conocer la ruta exacta. */
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

/** Carga la config de FE del tenant (settings type='electronic-invoice'). */
async function loadFEConfig(tenantId: string): Promise<any> {
  const { data } = await db.from('settings').select('config')
    .eq('tenant_id', tenantId).eq('type', 'electronic-invoice').maybeSingle();
  const cfg = (data as any)?.config ?? {};
  // ApiKey del emisor SEGÚN AMBIENTE: producción vs QA/sandbox. Se resuelve acá
  // para que todos los handlers usen la llave correcta con `cfg.api_key_emisor`.
  // Fallback a la llave única legacy si la del ambiente no está.
  const env = cfg.environment === 'sandbox' ? 'sandbox' : 'production';
  const byEnv = env === 'sandbox'
    ? (cfg.api_key_emisor_sandbox || cfg.api_key_emisor)
    : (cfg.api_key_emisor_production || cfg.api_key_emisor);
  cfg.api_key_emisor = String(byEnv || '').trim();
  // ID de empresa de Alanube SEGÚN AMBIENTE (con fallback al legacy), para que
  // todos los handlers usen el companyId correcto con `cfg.alanube_company_id`.
  const companyByEnv = env === 'sandbox'
    ? (cfg.alanube_company_id_sandbox || cfg.alanube_company_id)
    : (cfg.alanube_company_id_production || cfg.alanube_company_id);
  cfg.alanube_company_id = companyByEnv ? String(companyByEnv).trim() : '';
  return cfg;
}

/**
 * Cuota de comprobantes del plan FE como BOLSA (bucket) prepagada. Se otorga una
 * cantidad fija (fe_included_docs, ej. 300) que se gasta hasta agotarse — puede
 * durar meses o un año. NO se acumula por mes. Cuando el cliente paga, se renueva
 * (POST /admin/tenants/:id/fe-renew reinicia fe_quota_start a hoy → bolsa nueva).
 * Umbrales de aviso: quedan 50, 20 y 10 comprobantes.
 */
/** Tenant principal del grupo (para heredar plan/bolsa FE en sucursales). */
async function groupMainTenantId(tenantId: string): Promise<string | null> {
  const { data: gm } = await db.from('tenant_group_members')
    .select('group_id').eq('tenant_id', tenantId).maybeSingle();
  const groupId = (gm as any)?.group_id;
  if (!groupId) return null;
  const { data: grp } = await db.from('tenant_groups')
    .select('main_tenant_id').eq('id', groupId).maybeSingle();
  let mainId = (grp as any)?.main_tenant_id ?? null;
  if (!mainId) {
    const { data: m } = await db.from('tenant_group_members')
      .select('tenant_id').eq('group_id', groupId).eq('role', 'main').maybeSingle();
    mainId = (m as any)?.tenant_id ?? null;
  }
  return mainId && mainId !== tenantId ? mainId : null;
}

async function computeFeQuota(tenantId: string) {
  const cfg = await loadFEConfig(tenantId);
  // Un solo contador: facturas, tiquetes Y notas de crédito cuentan juntos.
  let included = Number(cfg.fe_included_docs ?? 0);         // comprobantes por bolsa (0 = ilimitado)
  let extraFee = Number(cfg.fe_extra_fee ?? 0);             // ₡ por comprobante extra

  // Inicio de la bolsa vigente: fe_quota_start (se reinicia al renovar/pagar);
  // si no existe, cae al inicio de la suscripción o creación del tenant.
  let startISO: string = cfg.fe_quota_start ?? '';

  // Sucursal sin bolsa propia → hereda la del negocio principal del grupo.
  if (!included) {
    const mainId = await groupMainTenantId(tenantId);
    if (mainId) {
      const mcfg = await loadFEConfig(mainId);
      const mInc = Number(mcfg.fe_included_docs ?? 0);
      if (mInc > 0) {
        included = mInc;
        extraFee = Number(mcfg.fe_extra_fee ?? 0);
        if (!startISO) startISO = mcfg.fe_quota_start ?? '';
      }
    }
  }
  if (!startISO) {
    const { data: t } = await db.from('tenants')
      .select('created_at, subscription:subscriptions!tenants_subscription_id_fkey(started_at)')
      .eq('id', tenantId).maybeSingle();
    startISO = (t as any)?.subscription?.started_at ?? (t as any)?.created_at ?? new Date().toISOString();
  }

  // Comprobantes emitidos DESDE el inicio de la bolsa. Cada CLAVE cuenta 1:
  // factura/tiquete (fe_clave) + NC (fe_nc_clave) + ND (fe_nd_clave). Se EXCLUYEN
  // los RECHAZADOS/ERROR (no consumen bolsa: no son comprobantes válidos).
  const failed = (s: any) => s === 'rejected' || s === 'error';
  let feRows: any = await db.from('invoices')
    .select('fe_clave, fe_status, fe_nc_clave, fe_nc_status, fe_nd_clave, fe_nd_status')
    .eq('tenant_id', tenantId).gte('created_at', startISO)
    .or('fe_clave.not.is.null,fe_nc_clave.not.is.null,fe_nd_clave.not.is.null');
  if (feRows.error) {   // columnas NC/ND (o su status) sin migrar → intento mínimo
    feRows = await db.from('invoices').select('fe_clave, fe_status')
      .eq('tenant_id', tenantId).gte('created_at', startISO).not('fe_clave', 'is', null);
  }
  let usedDocs = 0, usedNc = 0, usedNd = 0;
  for (const r of (feRows.data ?? []) as any[]) {
    if (r.fe_clave && !failed(r.fe_status)) usedDocs++;
    if (r.fe_nc_clave && !failed(r.fe_nc_status)) usedNc++;
    if (r.fe_nd_clave && !failed(r.fe_nd_status)) usedNd++;
  }

  const used = usedDocs + usedNc + usedNd;                  // facturas + tiquetes + NC + ND (sin rechazados)
  const available = included > 0 ? included - used : null;  // null = ilimitado
  const overage = included > 0 ? Math.max(0, used - included) : 0;

  return {
    included, extra_fee: extraFee, quota_start: startISO, months_elapsed: 1,
    used, used_docs: usedDocs, used_nc: usedNc, used_nd: usedNd,
    available,
    overage,
    extra_charge: extraFee * overage,
  };
}

// GET /quota — cuota de comprobantes del plan (para Mi Plan y avisos).
hacienda.get('/quota', async (c) => {
  try { return ok(c, await computeFeQuota(c.get('tenantId'))); }
  catch (err: any) { return fail(c, err.message, 500); }
});

// GET /provider — proveedor de FE del tenant actual (para ocultar funciones de
// Alanube en el frontend cuando no está seleccionado).
hacienda.get('/provider', async (c) => {
  try {
    const cfg = await loadFEConfig(c.get('tenantId'));
    return ok(c, {
      provider: cfg.fe_provider === 'alanube' ? 'alanube' : 'facturemos',
      enabled: !!cfg.enabled,
    });
  } catch { return ok(c, { provider: 'facturemos', enabled: false }); }
});

/** Cédula GLOBAL del proveedor de sistemas (app_config key='fe'). */
async function globalProveedorSistemas(): Promise<string> {
  try {
    const { data } = await db.from('app_config').select('value').eq('key', 'fe').maybeSingle();
    return String((data as any)?.value?.proveedor_sistemas ?? '');
  } catch { return ''; }
}

// POST /test-connection — verifica que el ApiKeyCliente (servidor) obtenga token
// para el ambiente configurado por el tenant. No emite nada.
hacienda.post('/test-connection', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const cfg = await loadFEConfig(tenantId);
    const env = cfg.environment === 'sandbox' ? 'sandbox' : 'production'; // default producción

    await obtenerToken(env);   // si falla, lanza FacturemosError

    return ok(c, {
      token_ok: true,
      environment: env,
      emisor_configured: !!cfg.api_key_emisor,
      message: cfg.api_key_emisor
        ? 'Conexión con Facturemos correcta. Emisor configurado.'
        : 'Token obtenido. Falta configurar la ApiKey del emisor para poder emitir.',
    });
  } catch (err: any) {
    const status = err instanceof FacturemosError ? err.status : 500;
    return fail(c, err.message, status);
  }
});

// GET /status/:clave — consulta el estatus de un documento ya emitido.
hacienda.get('/status/:clave', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { clave } = c.req.param();
    const cfg = await loadFEConfig(tenantId);
    if (!cfg.api_key_emisor) return fail(c, 'Falta configurar la ApiKey del emisor', 422);
    const env = cfg.environment === 'sandbox' ? 'sandbox' : 'production'; // default producción
    const data = await consultaEstatus(env, cfg.api_key_emisor, clave);
    return ok(c, data);
  } catch (err: any) {
    const status = err instanceof FacturemosError ? err.status : 500;
    return fail(c, err.message, status);
  }
});

/** Traduce errores crípticos de Facturemos/Hacienda a mensajes claros en español. */
function friendlyFEError(raw: string): string {
  const m = String(raw || '');
  const l = m.toLowerCase();
  // Los mensajes ya-claros de autenticación del SERVIDOR/ambiente (clave maestra)
  // se dejan tal cual — no los pisamos con el genérico de "ApiKey del emisor".
  if (/autenticaci[oó]n del servidor|apikey maestra|ambiente\b/i.test(l)) return m;
  const map: Array<[RegExp, string]> = [
    [/código de producto\/servicio|codigocabys|cabys/i, 'Falta el código CABYS en uno o más productos. Asignáselo en Inventario → Productos (o configurá un CABYS por defecto en Facturación Electrónica).'],
    [/detalle no debe estar vac/i, 'La factura no tiene líneas de detalle.'],
    [/receptor\.correoelectronico|correo.*receptor/i, 'El correo del cliente (receptor) es inválido.'],
    [/correoelectronico|correo/i, 'Hay un correo electrónico con formato inválido (emisor o receptor).'],
    [/provincia del emisor|ubicaci[oó]n.*emisor/i, 'La ubicación del emisor está mal configurada (provincia/cantón/distrito).'],
    [/actividad|codigoactividad/i, 'Falta o es inválido el código de actividad económica del emisor.'],
    [/antig[uü]edad de 10 a[nñ]os|no puede ser futura/i, 'La fecha de referencia de la nota de crédito es inválida.'],
    [/impuestoasumidoemisorfabrica/i, 'Error interno de impuestos en una línea. Contactá soporte.'],
    [/apikey|token|no autorizado|unauthorized/i, 'Error de autenticación con Facturemos. Revisá la ApiKey del emisor y el ambiente.'],
    [/identificaci[oó]n|c[eé]dula/i, 'La identificación (cédula) del emisor o receptor es inválida.'],
    [/consecutivo|clave/i, 'Problema con el consecutivo/clave del comprobante.'],
  ];
  for (const [re, friendly] of map) if (re.test(l)) return `${friendly}`;
  return m;
}

/** Mapea el Ind_estado de Hacienda a nuestro fe_status. */
function mapEstado(ind: string): string {
  const s = String(ind ?? '').toLowerCase();
  if (s.includes('acept')) return 'accepted';
  if (s.includes('rechaz')) return 'rejected';
  return 'sent';   // procesando / recibido
}

/** Limpia el governmentResponse de Hacienda (texto crudo con códigos) y devuelve
 *  los mensajes de error en una lista legible. */
function cleanHaciendaError(raw: any): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // Hacienda devuelve "." (o vacío) cuando ACEPTA sin observaciones: NO es un error.
  // Cualquier respuesta sin letras (solo puntos/ceros/comas) se trata como "sin error".
  if (!/[a-zA-ZáéíóúñÁÉÍÓÚÑ]/.test(s)) return null;
  // Cada error viene como:  -99, ""mensaje"", 0, 0
  const msgs: string[] = [];
  const re = /(-?\d+)\s*,\s*""([\s\S]*?)""\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const msg = m[2].replace(/\s+/g, ' ').trim();
    if (msg) msgs.push(msg);
  }
  if (msgs.length) return msgs.map((x, i) => `${i + 1}. ${x}`).join('\n');
  // Sin códigos: devolvemos el texto tal cual (limpiando saltos).
  return s.replace(/\s+/g, ' ').trim();
}

/** Tipo de documento (columna) → kind de Alanube para consultar el recurso. */
function feKindOf(documentType?: string | null): 'invoice' | 'ticket' | 'credit-note' | 'debit-note' {
  switch (String(documentType ?? '')) {
    case 'factura_electronica': return 'invoice';
    case 'nota_credito':        return 'credit-note';
    case 'nota_debito':         return 'debit-note';
    default:                    return 'ticket';   // tiquete_electronico y otros
  }
}

/** Mapea el status de Alanube / Hacienda a fe_status. */
function mapAlanubeStatus(s: any): string {
  const t = String(s ?? '').toUpperCase().trim();
  if (!t) return 'sent';
  // Aceptado: strings o Ind_estado de Hacienda = "1" (aceptado).
  if (t.includes('ACCEPT') || t.includes('ACEPT') || t.includes('APROB') || t.includes('APPROV')
    || t === 'DELIVERED' || t === 'COMPLETED' || t === 'DONE' || t === '1') return 'accepted';
  // Rechazado: strings o Ind_estado = "2".
  if (t.includes('REJECT') || t.includes('RECHAZ') || t.includes('DENIED') || t === '2') return 'rejected';
  if (t.includes('ERROR') || t.includes('FAIL')) return 'error';
  return 'sent';   // REGISTERED / PENDING / PROCESSING / RECEIVED / "3" (recibido)…
}

/** Consulta el estado de un documento en Alanube por su id (ULID). Devuelve
 *  también la clave real de Hacienda (50 díg) y el estado CRUDO (para depurar). */
async function alanubeDocStatus(client: ReturnType<typeof alanube.forEnv>, docId: string, opts?: { kind?: 'invoice' | 'ticket' | 'credit-note' | 'debit-note'; companyId?: string }): Promise<{ status: string; rawStatus: any; clave: string | null; error: string | null; raw: any }> {
  const doc: any = await client.getDocument(docId, opts);
  const d = doc?.document ?? doc?.invoice ?? doc?.ticket ?? doc?.creditNote ?? doc?.debitNote ?? doc?.data ?? doc;
  // En CRI el estado de HACIENDA viene en `legalStatus` (ACCEPTED/REJECTED); el
  // `status` es el ciclo de vida de Alanube (REGISTERED/FINISHED). Priorizamos legalStatus.
  const rawStatus = d?.legalStatus ?? d?.haciendaStatus ?? d?.indEstado ?? d?.hacienda?.status
    ?? deepFind(doc, /(legalStatus|indEstado|haciendaStatus)/i, 20)
    ?? d?.status ?? deepFind(doc, /(^status$|estado|situacion)/i, 20);
  const clave = d?.key ?? d?.clave ?? deepFind(doc, /(clave|^key$)/i, 40) ?? null;
  const rawErr = d?.governmentResponse ?? d?.errorMessage ?? deepFind(doc, /(governmentResponse|errorMessage)/i, 5000) ?? null;
  return { status: mapAlanubeStatus(rawStatus), rawStatus, clave, error: cleanHaciendaError(rawErr), raw: doc };
}

// POST /refresh-status — consulta el estatus de una factura por su Clave y lo GUARDA.
hacienda.post('/refresh-status', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { invoice_id } = await c.req.json().catch(() => ({}));
    if (!invoice_id) return fail(c, 'Falta invoice_id', 422);

    const cfg = await loadFEConfig(tenantId);
    const provider = cfg.fe_provider === 'alanube' ? 'alanube' : 'facturemos';
    if (provider === 'facturemos' && !cfg.api_key_emisor) return fail(c, 'Falta configurar la ApiKey del emisor', 422);
    const env = cfg.environment === 'sandbox' ? 'sandbox' : 'production'; // default producción

    const { data: inv } = await db.from('invoices')
      .select('id, fe_clave, fe_consecutivo, document_type').eq('id', invoice_id).eq('tenant_id', tenantId).maybeSingle();
    if (!(inv as any)?.fe_clave) return fail(c, 'La factura no fue emitida', 422);

    let fe_status = 'sent';
    const patch: Record<string, any> = { updated_at: new Date().toISOString() };
    let indEstado: any = null, errDetail: any = null;
    if (provider === 'alanube') {
      const docId = (inv as any).fe_consecutivo;
      if (!docId) return fail(c, 'No hay id de documento de Alanube para consultar. Volvé a emitir.', 422);
      const r = await alanubeDocStatus(alanube.forEnv(cfg.environment), docId, { kind: feKindOf((inv as any).document_type) });
      fe_status = r.status; indEstado = r.rawStatus; errDetail = r.error;
      patch.fe_status = fe_status;
      patch.fe_error = r.error;    // motivo del rechazo de Hacienda (si lo hay)
      patch.fe_response = r.raw;   // guardar la respuesta cruda para la bitácora
      // Si ya llegó la clave real de Hacienda (50 díg) y aún guardábamos el ULID,
      // la persistimos para mostrar clave y consecutivo correctos.
      if (r.clave && /^\d{50}$/.test(String(r.clave)) && r.clave !== (inv as any).fe_clave) {
        patch.fe_clave = r.clave;
      }
    } else {
      const data = await consultaEstatus(env, cfg.api_key_emisor, (inv as any).fe_clave);
      fe_status = mapEstado(data?.Ind_estado);
      indEstado = data?.Ind_estado ?? null; errDetail = data?.Error ?? null;
      patch.fe_status = fe_status;
      patch.fe_xml = data?.Respuesta_xml ?? null;
      patch.fe_error = data?.Error ?? null;
    }
    let upd = await db.from('invoices').update(patch).eq('id', invoice_id).eq('tenant_id', tenantId);
    if (upd.error && /fe_response|fe_request/.test(upd.error.message)) {
      const { fe_response, fe_request, ...rest } = patch;   // migración 55 sin correr
      upd = await db.from('invoices').update(rest).eq('id', invoice_id).eq('tenant_id', tenantId);
    }
    // Al ACEPTARSE, enviar automáticamente el comprobante completo al cliente.
    if (fe_status === 'accepted') autoSendComprobanteToCustomer(tenantId, invoice_id);

    return ok(c, { fe_status, ind_estado: indEstado, error: errDetail });
  } catch (err: any) {
    const status = err instanceof FacturemosError ? err.status : 500;
    return fail(c, err.message, status);
  }
});

// POST /refresh-pending — consulta en Hacienda TODOS los comprobantes en proceso
// (fe_status='sent') y actualiza su estado. Para que FE Facturas no se quede en
// "pendiente" sin que nadie consulte uno por uno.
hacienda.post('/refresh-pending', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const cfg = await loadFEConfig(tenantId);
    const provider = cfg.fe_provider === 'alanube' ? 'alanube' : 'facturemos';
    if (provider === 'facturemos' && !cfg.api_key_emisor) return ok(c, { updated: 0 });
    const env = cfg.environment === 'sandbox' ? 'sandbox' : 'production'; // default producción

    const { data: pend } = await db.from('invoices')
      .select('id, fe_clave, fe_consecutivo, document_type')
      .eq('tenant_id', tenantId).eq('fe_status', 'sent').not('fe_clave', 'is', null)
      .order('issued_at', { ascending: false }).limit(60);

    let updated = 0;
    for (const inv of (pend ?? []) as any[]) {
      try {
        let fe_status = 'sent';
        const patch: Record<string, any> = { updated_at: new Date().toISOString() };
        if (provider === 'alanube') {
          if (!inv.fe_consecutivo) continue;   // sin id de Alanube no podemos consultar
          const kind = feKindOf(inv.document_type);
          const r = await alanubeDocStatus(alanube.forEnv(cfg.environment), inv.fe_consecutivo, { kind });
          fe_status = r.status;
          patch.fe_error = r.error;    // motivo del rechazo (si lo hay)
          patch.fe_response = r.raw;   // respuesta cruda para depurar el estado
          if (r.clave && /^\d{50}$/.test(String(r.clave)) && r.clave !== inv.fe_clave) patch.fe_clave = r.clave;
        } else {
          const data = await consultaEstatus(env, cfg.api_key_emisor, inv.fe_clave);
          fe_status = mapEstado(data?.Ind_estado);
          patch.fe_xml = data?.Respuesta_xml ?? null;
          patch.fe_error = data?.Error ?? null;
        }
        if (fe_status !== 'sent' || patch.fe_clave) {
          patch.fe_status = fe_status;
          await db.from('invoices').update(patch).eq('id', inv.id).eq('tenant_id', tenantId);
          updated++;
          // Al ACEPTARSE, enviar el comprobante completo al cliente.
          if (fe_status === 'accepted') autoSendComprobanteToCustomer(tenantId, inv.id);
        }
      } catch { /* seguir con los demás */ }
    }
    return ok(c, { updated });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /emit — emite un documento electrónico (tiquete/factura) a Hacienda vía
// Facturemos a partir de una factura existente. body: { invoice_id }.
hacienda.post('/emit', async (c) => {
  const tenantId = c.get('tenantId');
  let invoice_id: string | undefined;
  let debug = false;
  try {
    ({ invoice_id, debug } = await c.req.json().catch(() => ({})));
    if (!invoice_id) return fail(c, 'Falta invoice_id', 422);

    const cfg = await loadFEConfig(tenantId);
    if (!cfg.enabled) return fail(c, 'La facturación electrónica no está activada', 409);
    const provider = cfg.fe_provider === 'alanube' ? 'alanube' : 'facturemos';
    if (provider === 'facturemos' && !cfg.api_key_emisor) return fail(c, 'Falta configurar la ApiKey del emisor', 422);
    if (provider === 'alanube' && !cfg.alanube_company_id) return fail(c, 'La empresa no está dada de alta en Alanube. Usá «Crear empresa en Alanube».', 422);
    const env = cfg.environment === 'sandbox' ? 'sandbox' : 'production'; // default producción

    // Factura + ítems.
    const { data: inv } = await db.from('invoices')
      .select('*, invoice_items(*)').eq('id', invoice_id).eq('tenant_id', tenantId).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    if ((inv as any).fe_clave) return fail(c, 'La factura ya fue emitida', 409);

    const allItems: any[] = (inv as any).invoice_items ?? [];
    const pids = [...new Set(allItems.map(it => it.product_id).filter(Boolean))];
    const prodMap = new Map<string, any>();
    if (pids.length > 0) {
      const { data: prods } = await db.from('products')
        .select('id, name, sku, cabys_code, iva_rate, exclude_from_fe, unit_type:unit_types(abbreviation)').in('id', pids as string[]);
      for (const p of prods ?? []) prodMap.set((p as any).id, p);
    }
    // No se envían a Hacienda los productos SIN PRECIO (precio 0) ni los marcados
    // "no enviar a Hacienda". Igual quedan en la venta y en el ticket.
    const items = allItems.filter((it: any) =>
      Number(it.unit_price) > 0 && !prodMap.get(it.product_id)?.exclude_from_fe);
    const defaultCabys = String(cfg.default_cabys ?? '').replace(/\D/g, '') || null;
    const lines: FELine[] = items.map((it: any) => {
      const p = prodMap.get(it.product_id) ?? {};
      return {
        product_name: p.name ?? 'Producto',
        sku: p.sku ?? null,
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price),
        subtotal: Number(it.subtotal),
        cabys_code: (p.cabys_code ? String(p.cabys_code).replace(/\D/g, '') : '') || defaultCabys,
        iva_rate: p.iva_rate ?? 0,
        unit: (p.unit_type?.abbreviation) ?? 'Unid',
      };
    }).filter((l: FELine) => Number(l.quantity) > 0 && l.product_name);
    // Marca la factura con estado 'error' y devuelve el fallo (así en FE Facturas
    // aparece como ERROR y no como pendiente/en proceso).
    const failFE = async (msg: string) => {
      try {
        await db.from('invoices').update({ fe_status: 'error', fe_error: msg })
          .eq('id', invoice_id!).eq('tenant_id', tenantId);
      } catch { /* ignore */ }
      return fail(c, msg, 422);
    };

    if (lines.length === 0) return await failFE('La factura no tiene líneas de detalle para emitir.');

    // Hacienda exige CodigoCABYS en cada línea. Avisar con nombre del producto.
    const sinCabys = lines.filter((l: FELine) => !l.cabys_code);
    if (sinCabys.length > 0) {
      const nombres = [...new Set(sinCabys.map((l: FELine) => l.product_name))].join(', ');
      return await failFE(`Estos productos no tienen código CABYS: ${nombres}. Asignáselo en el producto (o configurá un CABYS por defecto en Facturación Electrónica).`);
    }

    // Receptor (cliente), opcional para tiquete.
    let receptor: any = null;
    if ((inv as any).customer_id) {
      const { data: cust } = await db.from('customers')
        .select('name, identification_type, identification, email, province_code, canton_code, district_code, address')
        .eq('id', (inv as any).customer_id).maybeSingle();
      receptor = cust ?? null;
    } else if ((inv as any).customer_name) {
      receptor = { name: (inv as any).customer_name };
    }

    const emisor = {
      identification_type: cfg.emisor_identification_type ?? '02',
      identification: cfg.emisor_identification ?? '',
      name: cfg.emisor_name ?? '',
      commercial_name: cfg.emisor_commercial_name ?? '',
      province_code: cfg.emisor_province_code ?? '',
      canton_code: cfg.emisor_canton_code ?? '',
      district_code: cfg.emisor_district_code ?? '',
      address: cfg.emisor_address ?? '',
      phone: cfg.emisor_phone ?? '',
      email: cfg.emisor_email ?? '',
      economic_activity_code: cfg.economic_activity_code ?? '',
      proveedor_sistemas: (await globalProveedorSistemas()) || cfg.proveedor_sistemas || '',
    };

    // Tipo de comprobante según lo elegido en el POS (columna document_type):
    //   factura_electronica → 01 · tiquete_electronico/ticket → 04.
    // La factura exige receptor identificado (cédula), si no la rechaza Hacienda.
    const receptorConCedula = !!(receptor?.identification && receptor?.identification_type);
    const tipoDoc = (inv as any).document_type === 'factura_electronica' ? '01' : '04';
    if (tipoDoc === '01' && !receptorConCedula) {
      return await failFE('Para emitir Factura Electrónica el cliente debe tener cédula (identificación). Seleccioná un cliente registrado con identificación o emití como tiquete.');
    }

    // ── Proveedor ALANUBE ─────────────────────────────────────────────────────
    if (provider === 'alanube') {
      const kind = tipoDoc === '01' ? 'invoice' : 'ticket';
      const doc = buildAlanubeDocument(emisor, inv as any, lines, receptor, {
        tipoDoc,
        headquarters: cfg.sucursal, terminal: cfg.terminal,
        numberOfDocument: (inv as any).invoice_number,
        // Empresa emisora en Alanube según el ambiente (para que emita el tenant y
        // no la 'main' de la cuenta). Sin id, Alanube usa la main por defecto.
        senderId: (String(cfg.environment ?? 'production') === 'sandbox'
          ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id,
      });
      if (debug) {
        return ok(c, { provider: 'alanube', environment: env, kind, company_id: cfg.alanube_company_id, payload: doc });
      }
      let resp: any;
      try {
        resp = await alanube.forEnv(cfg.environment).emitDocument(kind as any, doc, cfg.alanube_company_id);
      } catch (e: any) {
        // Guardar el JSON enviado para poder verlo en la bitácora aunque falle.
        await db.from('invoices').update({ fe_request: doc }).eq('id', invoice_id).eq('tenant_id', tenantId).then(() => {}, () => {});
        return await failFE(e instanceof AlanubeError ? e.message : (e?.message ?? 'Error emitiendo con Alanube'));
      }
      // La respuesta viene envuelta según el tipo: { ticket|invoice|creditNote: {
      //   id (ULID), key (clave 50 díg de Hacienda), status } }.
      const docObj = resp?.ticket ?? resp?.invoice ?? resp?.creditNote ?? resp?.document ?? resp?.data ?? resp;
      const docId = docObj?.id ?? deepFind(resp, /(^id$|_id$|documentId$)/i, 10) ?? null;
      const clave = docObj?.key ?? docObj?.clave ?? deepFind(resp, /(clave|^key$)/i, 40) ?? null;
      const alanubeStatus = docObj?.status ?? null;   // REGISTERED, ACCEPTED, REJECTED…
      await db.from('invoices').update({
        fe_clave: clave ?? docId,           // preferimos la clave real de Hacienda
        fe_consecutivo: docId,              // id ULID de Alanube (para consultar estado)
        fe_status: 'sent',
        fe_situacion: '1',
        fe_environment: env,                // ambiente (production/sandbox) del comprobante
        fe_error: null,
        fe_request: doc,                    // JSON enviado (para la bitácora)
        fe_response: resp,                  // respuesta de Alanube/Hacienda
        document_type: tipoDoc === '01' ? 'factura_electronica' : 'tiquete_electronico',
        sale_condition: (inv as any).payment_method === 'credit' ? '02' : '01',
        updated_at: new Date().toISOString(),
      }).eq('id', invoice_id).eq('tenant_id', tenantId);

      // El correo al cliente se envía AUTOMÁTICAMENTE al ACEPTARSE (con los dos
      // XML + PDF), no al emitir — la respuesta de Hacienda aún no existe acá.

      return ok(c, { ok: true, provider: 'alanube', clave, alanube_doc_id: docId, alanube_status: alanubeStatus, tipo: tipoDoc, response: resp });
    }

    // ── Proveedor FACTUREMOS (flujo existente) ────────────────────────────────
    const consecutivo = buildConsecutivo(inv as any, {
      sucursal: cfg.sucursal, terminal: cfg.terminal, situacion: '1', tipoComprobante: tipoDoc,
    });
    const facturaJson = buildDocumentoJson(emisor, inv as any, lines, receptor, { tipoComprobante: tipoDoc });

    const apiMasked = String(cfg.api_key_emisor).slice(-4);
    // Modo debug: NO envía. Devuelve exactamente lo que mandaríamos, para
    // compartir con soporte de Facturemos.
    if (debug) {
      return ok(c, {
        environment: env,
        apiKeyEmisor_last4: apiMasked,
        emisor_cedula: emisor.identification,
        ConsecutivoModel: consecutivo,
        Factura: JSON.parse(facturaJson),
      });
    }

    // Enviar a Facturemos.
    const resp = await enviaDocumentoConsecutivoJson(env, cfg.api_key_emisor, facturaJson, consecutivo);

    // La respuesta de emisión puede venir como string (la clave) o como objeto.
    const clave = typeof resp === 'string' ? resp : (resp?.Clave ?? resp?.clave ?? null);
    const consec = typeof resp === 'object' ? (resp?.Consecutivo ?? resp?.NumeroConsecutivo ?? null) : null;

    await db.from('invoices').update({
      fe_clave: clave,
      fe_consecutivo: consec,
      fe_status: 'sent',
      fe_situacion: '1',
      fe_environment: env,
      document_type: tipoDoc === '01' ? 'factura_electronica' : 'tiquete_electronico',
      sale_condition: (inv as any).payment_method === 'credit' ? '02' : '01',
      updated_at: new Date().toISOString(),
    }).eq('id', invoice_id).eq('tenant_id', tenantId);

    return ok(c, { ok: true, clave, consecutivo: consec, tipo: tipoDoc, response: resp });
  } catch (err: any) {
    const status = err instanceof FacturemosError ? err.status : 500;
    const friendly = friendlyFEError(err.message);
    // Guardar el error (claro) en la factura para diagnóstico.
    if (invoice_id) {
      try {
        await db.from('invoices').update({ fe_status: 'error', fe_error: friendly })
          .eq('id', invoice_id).eq('tenant_id', tenantId);
      } catch { /* ignore */ }
    }
    return fail(c, friendly, status);
  }
});

// POST /credit-note — emite una Nota de Crédito (03) que ANULA una factura ya
// emitida. body: { invoice_id, reason? }.
hacienda.post('/credit-note', async (c) => {
  const tenantId = c.get('tenantId');
  let invoice_id: string | undefined;
  try {
    let reason: string | undefined;
    ({ invoice_id, reason } = await c.req.json().catch(() => ({})));
    if (!invoice_id) return fail(c, 'Falta invoice_id', 422);

    const cfg = await loadFEConfig(tenantId);
    const provider = cfg.fe_provider === 'alanube' ? 'alanube' : 'facturemos';
    if (provider === 'facturemos' && !cfg.api_key_emisor) return fail(c, 'Falta configurar la ApiKey del emisor', 422);
    const alanubeCompanyId = (String(cfg.environment ?? 'production') === 'sandbox'
      ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id;
    if (provider === 'alanube' && !alanubeCompanyId) return fail(c, 'La empresa no está dada de alta en Alanube.', 422);
    const env = cfg.environment === 'sandbox' ? 'sandbox' : 'production'; // default producción

    const { data: inv } = await db.from('invoices')
      .select('*, invoice_items(*)').eq('id', invoice_id).eq('tenant_id', tenantId).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    if (!(inv as any).fe_clave) return fail(c, 'La factura no fue emitida electrónicamente', 422);
    if ((inv as any).fe_nc_clave) return fail(c, 'La factura ya tiene una nota de crédito', 409);

    // Líneas (mismas que la factura original).
    const items: any[] = (inv as any).invoice_items ?? [];
    const pids = [...new Set(items.map(it => it.product_id).filter(Boolean))];
    const prodMap = new Map<string, any>();
    if (pids.length > 0) {
      const { data: prods } = await db.from('products')
        .select('id, name, sku, cabys_code, iva_rate, exclude_from_fe, unit_type:unit_types(abbreviation)').in('id', pids as string[]);
      for (const p of prods ?? []) prodMap.set((p as any).id, p);
    }
    const lines: FELine[] = items
      .filter((it: any) => Number(it.unit_price) > 0 && !prodMap.get(it.product_id)?.exclude_from_fe)   // sin precio / marcado → no va a Hacienda
      .map((it: any) => {
      const p = prodMap.get(it.product_id) ?? {};
      return {
        product_name: p.name ?? 'Producto', sku: p.sku ?? null,
        quantity: Number(it.quantity), unit_price: Number(it.unit_price), subtotal: Number(it.subtotal),
        cabys_code: p.cabys_code ?? null, iva_rate: p.iva_rate ?? 0,
        unit: (p.unit_type?.abbreviation) ?? 'Unid',
      };
    }).filter((l: FELine) => Number(l.quantity) > 0 && l.product_name);
    if (lines.length === 0) return fail(c, 'La factura no tiene líneas', 422);

    let receptor: any = null;
    if ((inv as any).customer_id) {
      const { data: cust } = await db.from('customers')
        .select('name, identification_type, identification, email, province_code, canton_code, district_code, address')
        .eq('id', (inv as any).customer_id).maybeSingle();
      receptor = cust ?? null;
    } else if ((inv as any).customer_name) receptor = { name: (inv as any).customer_name };

    const emisor = {
      identification_type: cfg.emisor_identification_type ?? '02', identification: cfg.emisor_identification ?? '',
      name: cfg.emisor_name ?? '', commercial_name: cfg.emisor_commercial_name ?? '',
      province_code: cfg.emisor_province_code ?? '', canton_code: cfg.emisor_canton_code ?? '',
      district_code: cfg.emisor_district_code ?? '', address: cfg.emisor_address ?? '',
      phone: cfg.emisor_phone ?? '', email: cfg.emisor_email ?? '',
      economic_activity_code: cfg.economic_activity_code ?? '', proveedor_sistemas: cfg.proveedor_sistemas ?? '',
    };

    const tipoOriginal = tipoComprobante((inv as any).document_type);   // 04 tiquete / 01 factura

    // ── Proveedor ALANUBE: nota de crédito (03) ───────────────────────────────
    if (provider === 'alanube') {
      const doc = buildAlanubeDocument(emisor, inv as any, lines, receptor, {
        tipoDoc: '03',
        headquarters: cfg.sucursal, terminal: cfg.terminal,
        numberOfDocument: (inv as any).invoice_number,
        // Empresa emisora en Alanube según el ambiente (para que emita el tenant y
        // no la 'main' de la cuenta). Sin id, Alanube usa la main por defecto.
        senderId: (String(cfg.environment ?? 'production') === 'sandbox'
          ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id,
        reference: {
          documentType: tipoOriginal,
          number: (inv as any).fe_clave,
          date: (inv as any).issued_at ?? new Date().toISOString(),
          code: '01',
          reason: reason || 'Anulación de documento',
        },
      });
      let resp: any;
      try {
        resp = await alanube.forEnv(cfg.environment).emitDocument('credit-note', doc, cfg.alanube_company_id);
      } catch (e: any) {
        return fail(c, e instanceof AlanubeError ? e.message : (e?.message ?? 'Error emitiendo NC con Alanube'), 422);
      }
      const docObj = resp?.creditNote ?? resp?.document ?? resp?.data ?? resp;
      const ncId = docObj?.id ?? deepFind(resp, /(^id$|_id$|documentId$)/i, 10) ?? null;
      const ncClave = docObj?.key ?? docObj?.clave ?? deepFind(resp, /(clave|^key$)/i, 40) ?? null;
      await db.from('invoices').update({
        fe_nc_clave: ncClave ?? ncId, fe_nc_status: 'sent',
        updated_at: new Date().toISOString(),
      }).eq('id', invoice_id).eq('tenant_id', tenantId);
      return ok(c, { ok: true, provider: 'alanube', nc_clave: ncClave, alanube_doc_id: ncId, response: resp });
    }

    // Consecutivo de NC (TipoComprobante 03) y referencia al documento original.
    const consecutivo = buildConsecutivo(inv as any, {
      sucursal: cfg.sucursal, terminal: cfg.terminal, situacion: '1', tipoComprobante: '03',
    });
    // La NC se emite HOY (no con la fecha del original).
    const nowMs = Date.now();
    const ncInv = { ...(inv as any), issued_at: new Date(nowMs).toISOString() };
    // Fecha de referencia: la del original, pero SIEMPRE anterior a ahora
    // (evita "no puede ser futura" por desfase de reloj con QA).
    const origMs = Date.parse((inv as any).issued_at ?? '') || nowMs;
    const refMs = Math.min(origMs, nowMs - 5 * 60 * 1000);   // al menos 5 min en el pasado
    const facturaJson = buildDocumentoJson(emisor, ncInv, lines, receptor, {
      tipoComprobante: '03',
      reference: {
        tipoDoc: tipoOriginal,
        numero: (inv as any).fe_clave,
        fecha: new Date(refMs).toISOString(),
        codigo: '01',
        razon: reason || 'Anulación de documento',
      },
    });

    const resp = await enviaDocumentoConsecutivoJson(env, cfg.api_key_emisor, facturaJson, consecutivo);
    const clave = typeof resp === 'string' ? resp : (resp?.Clave ?? resp?.clave ?? null);

    await db.from('invoices').update({
      fe_nc_clave: clave, fe_nc_status: 'sent', updated_at: new Date().toISOString(),
    }).eq('id', invoice_id).eq('tenant_id', tenantId);

    return ok(c, { ok: true, nc_clave: clave, response: resp });
  } catch (err: any) {
    const status = err instanceof FacturemosError ? err.status : 500;
    if (invoice_id) {
      try { await db.from('invoices').update({ fe_nc_status: 'error' }).eq('id', invoice_id).eq('tenant_id', tenantId); } catch { /* ignore */ }
    }
    return fail(c, friendlyFEError(err.message), status);
  }
});

// POST /debit-note — emite una Nota de Débito (02) que INCREMENTA/corrige el
// monto de un comprobante ya emitido. body: { invoice_id, reason? }.
hacienda.post('/debit-note', async (c) => {
  const tenantId = c.get('tenantId');
  let invoice_id: string | undefined;
  try {
    let reason: string | undefined;
    ({ invoice_id, reason } = await c.req.json().catch(() => ({})));
    if (!invoice_id) return fail(c, 'Falta invoice_id', 422);

    const cfg = await loadFEConfig(tenantId);
    const provider = cfg.fe_provider === 'alanube' ? 'alanube' : 'facturemos';
    if (provider === 'facturemos' && !cfg.api_key_emisor) return fail(c, 'Falta configurar la ApiKey del emisor', 422);
    const alanubeCompanyId = (String(cfg.environment ?? 'production') === 'sandbox'
      ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id;
    if (provider === 'alanube' && !alanubeCompanyId) return fail(c, 'La empresa no está dada de alta en Alanube.', 422);
    const env = cfg.environment === 'sandbox' ? 'sandbox' : 'production';

    const { data: inv } = await db.from('invoices')
      .select('*, invoice_items(*)').eq('id', invoice_id).eq('tenant_id', tenantId).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    if (!(inv as any).fe_clave) return fail(c, 'La factura no fue emitida electrónicamente', 422);
    if ((inv as any).fe_nd_clave) return fail(c, 'La factura ya tiene una nota de débito', 409);

    const items: any[] = (inv as any).invoice_items ?? [];
    const pids = [...new Set(items.map(it => it.product_id).filter(Boolean))];
    const prodMap = new Map<string, any>();
    if (pids.length > 0) {
      const { data: prods } = await db.from('products')
        .select('id, name, sku, cabys_code, iva_rate, exclude_from_fe, unit_type:unit_types(abbreviation)').in('id', pids as string[]);
      for (const p of prods ?? []) prodMap.set((p as any).id, p);
    }
    const lines: FELine[] = items
      .filter((it: any) => Number(it.unit_price) > 0 && !prodMap.get(it.product_id)?.exclude_from_fe)   // sin precio / marcado → no va a Hacienda
      .map((it: any) => {
      const p = prodMap.get(it.product_id) ?? {};
      return {
        product_name: p.name ?? 'Producto', sku: p.sku ?? null,
        quantity: Number(it.quantity), unit_price: Number(it.unit_price), subtotal: Number(it.subtotal),
        cabys_code: p.cabys_code ?? null, iva_rate: p.iva_rate ?? 0,
        unit: (p.unit_type?.abbreviation) ?? 'Unid',
      };
    }).filter((l: FELine) => Number(l.quantity) > 0 && l.product_name);
    if (lines.length === 0) return fail(c, 'La factura no tiene líneas', 422);

    let receptor: any = null;
    if ((inv as any).customer_id) {
      const { data: cust } = await db.from('customers')
        .select('name, identification_type, identification, email, province_code, canton_code, district_code, address')
        .eq('id', (inv as any).customer_id).maybeSingle();
      receptor = cust ?? null;
    } else if ((inv as any).customer_name) receptor = { name: (inv as any).customer_name };

    const emisor = {
      identification_type: cfg.emisor_identification_type ?? '02', identification: cfg.emisor_identification ?? '',
      name: cfg.emisor_name ?? '', commercial_name: cfg.emisor_commercial_name ?? '',
      province_code: cfg.emisor_province_code ?? '', canton_code: cfg.emisor_canton_code ?? '',
      district_code: cfg.emisor_district_code ?? '', address: cfg.emisor_address ?? '',
      phone: cfg.emisor_phone ?? '', email: cfg.emisor_email ?? '',
      economic_activity_code: cfg.economic_activity_code ?? '', proveedor_sistemas: cfg.proveedor_sistemas ?? '',
    };

    const tipoOriginal = tipoComprobante((inv as any).document_type);

    // ── Proveedor ALANUBE: nota de débito (02) ────────────────────────────────
    if (provider === 'alanube') {
      const doc = buildAlanubeDocument(emisor, inv as any, lines, receptor, {
        tipoDoc: '02',
        headquarters: cfg.sucursal, terminal: cfg.terminal,
        numberOfDocument: (inv as any).invoice_number,
        // Empresa emisora en Alanube según el ambiente (para que emita el tenant y
        // no la 'main' de la cuenta). Sin id, Alanube usa la main por defecto.
        senderId: (String(cfg.environment ?? 'production') === 'sandbox'
          ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id,
        reference: {
          documentType: tipoOriginal,
          number: (inv as any).fe_clave,
          date: (inv as any).issued_at ?? new Date().toISOString(),
          code: '02',   // 02 = corrige/incrementa monto
          reason: reason || 'Nota de débito',
        },
      });
      let resp: any;
      try {
        resp = await alanube.forEnv(cfg.environment).emitDocument('debit-note', doc, cfg.alanube_company_id);
      } catch (e: any) {
        return fail(c, e instanceof AlanubeError ? e.message : (e?.message ?? 'Error emitiendo ND con Alanube'), 422);
      }
      const docObj = resp?.debitNote ?? resp?.document ?? resp?.data ?? resp;
      const ndId = docObj?.id ?? deepFind(resp, /(^id$|_id$|documentId$)/i, 10) ?? null;
      const ndClave = docObj?.key ?? docObj?.clave ?? deepFind(resp, /(clave|^key$)/i, 40) ?? null;
      await db.from('invoices').update({
        fe_nd_clave: ndClave ?? ndId, fe_nd_status: 'sent', updated_at: new Date().toISOString(),
      }).eq('id', invoice_id).eq('tenant_id', tenantId);
      return ok(c, { ok: true, provider: 'alanube', nd_clave: ndClave, alanube_doc_id: ndId, response: resp });
    }

    // ── Proveedor FACTUREMOS ──────────────────────────────────────────────────
    const consecutivo = buildConsecutivo(inv as any, {
      sucursal: cfg.sucursal, terminal: cfg.terminal, situacion: '1', tipoComprobante: '02',
    });
    const nowMs = Date.now();
    const ndInv = { ...(inv as any), issued_at: new Date(nowMs).toISOString() };
    const origMs = Date.parse((inv as any).issued_at ?? '') || nowMs;
    const refMs = Math.min(origMs, nowMs - 5 * 60 * 1000);
    const facturaJson = buildDocumentoJson(emisor, ndInv, lines, receptor, {
      tipoComprobante: '02',
      reference: {
        tipoDoc: tipoOriginal,
        numero: (inv as any).fe_clave,
        fecha: new Date(refMs).toISOString(),
        codigo: '02',
        razon: reason || 'Nota de débito',
      },
    });

    const resp = await enviaDocumentoConsecutivoJson(env, cfg.api_key_emisor, facturaJson, consecutivo);
    const clave = typeof resp === 'string' ? resp : (resp?.Clave ?? resp?.clave ?? null);

    await db.from('invoices').update({
      fe_nd_clave: clave, fe_nd_status: 'sent', updated_at: new Date().toISOString(),
    }).eq('id', invoice_id).eq('tenant_id', tenantId);

    return ok(c, { ok: true, nd_clave: clave, response: resp });
  } catch (err: any) {
    const status = err instanceof FacturemosError ? err.status : 500;
    if (invoice_id) {
      try { await db.from('invoices').update({ fe_nd_status: 'error' }).eq('id', invoice_id).eq('tenant_id', tenantId); } catch { /* ignore */ }
    }
    return fail(c, friendlyFEError(err.message), status);
  }
});

// GET /invoices — lista de comprobantes electrónicos con su estatus FE.
// filtros: ?status=accepted|rejected|sent|error &from=&to=
hacienda.get('/invoices', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status');
    const from = c.req.query('from');
    const to = c.req.query('to');
    // Columnas base + FE. Las de Nota de Crédito (fe_nc_*) pueden no existir si
    // no se corrió la migración 33; si falla, reintentamos sin ellas.
    const buildQuery = (cols: string) => {
      let q = db.from('invoices').select(cols)
        .eq('tenant_id', tenantId)
        .or('document_type.eq.tiquete_electronico,document_type.eq.factura_electronica,fe_clave.not.is.null')
        .order('issued_at', { ascending: false })
        .limit(500);
      if (status) q = q.eq('fe_status', status);
      if (from) q = q.gte('issued_at', from);
      if (to)   q = q.lte('issued_at', endOfDay(to));
      return q;
    };
    const base = 'id, invoice_number, customer_name, total, issued_at, document_type, payment_method, status, fe_clave, fe_consecutivo, fe_status, fe_error, fe_emailed';
    // Intento con columnas de NC y ND; si alguna no existe (migración sin correr),
    // reintentamos con menos columnas.
    const baseNoEmail = base.replace(', fe_emailed', '');
    let { data, error } = await buildQuery(`${base}, fe_nc_clave, fe_nc_status, fe_nd_clave, fe_nd_status`);
    if (error && /fe_nd_/.test(error.message)) {
      ({ data, error } = await buildQuery(`${base}, fe_nc_clave, fe_nc_status`));   // sin ND
    }
    if (error && /fe_nc_/.test(error.message)) {
      ({ data, error } = await buildQuery(base));   // sin NC ni ND
    }
    if (error && /fe_emailed/.test(error.message)) {
      ({ data, error } = await buildQuery(baseNoEmail));   // sin fe_emailed (migración 56)
    }
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── RECEPCIÓN de comprobantes (Mensaje Receptor) — solo Alanube ───────────────

// NOTA CRI: Alanube NO expone un endpoint para LISTAR comprobantes recibidos
// (eso es solo DOM). En CRI se envía el Mensaje Receptor con `POST
// /receiver-messages`. La bandeja se alimenta registrando el documento del
// proveedor (manual/XML) en `received_documents`; a futuro, por webhook.

// GET /received — bandeja de comprobantes recibidos (desde nuestra tabla).
// La recepción se alimenta por CORREO (cron): ya NO depende de Alanube.
hacienda.get('/received', async (c) => {
  try {
    const tenantId = c.get('tenantId');

    const { data, error } = await db.from('received_documents')
      .select('*').eq('tenant_id', tenantId)
      .order('doc_date', { ascending: false }).limit(300);
    if (error) {
      // Si la tabla aún no existe (migración sin correr), devolvemos vacío con nota.
      if (/received_documents/.test(error.message)) return ok(c, []);
      throw new Error(error.message);
    }
    // Normaliza las líneas del XML (raw.lines usa subtotal) al formato del front
    // (items: { detail, quantity, unit_price, total }).
    const normItems = (d: any) => {
      const lines = d.raw?.lines ?? d.items;
      if (!Array.isArray(lines)) return null;
      return lines.map((l: any) => ({
        detail: l.detail ?? l.Detalle ?? '',
        quantity: Number(l.quantity ?? l.Cantidad ?? 1),
        unit: l.unit ?? null,
        unit_price: Number(l.unit_price ?? l.PrecioUnitario ?? 0),
        total: Number(l.total ?? l.subtotal ?? l.SubTotal ?? 0),
        cabys: l.cabys ?? l.CodigoCABYS ?? null,
        code: l.code ?? null,
      }));
    };
    // Números de orden de compra (consecutivo PO-XXXX) de los recibidos ligados.
    const purchaseIds = [...new Set((data ?? []).map((d: any) => d.purchase_id).filter(Boolean))];
    const poNumber = new Map<string, string>();
    if (purchaseIds.length) {
      const { data: pos } = await db.from('purchases').select('id, purchase_number').in('id', purchaseIds);
      for (const p of (pos ?? []) as any[]) poNumber.set(p.id, p.purchase_number);
    }
    return ok(c, (data ?? []).map((d: any) => ({
      id: d.id, clave: d.clave, issuer_name: d.issuer_name, issuer_id: d.issuer_id,
      document_type: d.document_type, date: d.doc_date, total: Number(d.total ?? 0),
      tax: Number(d.tax ?? 0), ack_status: d.ack_status,
      source: d.source ?? null, email_from: d.email_from ?? null,
      purchase_id: d.purchase_id ?? null,
      purchase_number: d.purchase_id ? (poNumber.get(d.purchase_id) ?? null) : null,
      // 'compra' solo si el usuario lo confirmó (kind); NO por tener borrador.
      kind: d.kind ?? null,
      items: normItems(d),
    })));
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /received/confirm — envía el Mensaje Receptor a Hacienda vía Alanube
// (aceptación total 1 / rechazo 3). body: { id, state: '1'|'3', reason? }
hacienda.post('/received/confirm', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id, state, reason } = await c.req.json().catch(() => ({}));
    if (!id) return fail(c, 'Falta el id del comprobante', 422);
    const st = String(state) === '3' ? '3' : '1';

    const cfg = await loadFEConfig(tenantId);
    const { data: doc } = await db.from('received_documents')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!doc) return fail(c, 'Comprobante recibido no encontrado', 404);
    const d = doc as any;

    const messages: string[] = [];
    let createdCount = 0;

    // Al ACEPTAR: recién ahora se crean los productos pendientes (los nuevos del
    // comprobante) y se agregan a la orden de compra ligada.
    if (st === '1') {
      const pending: any[] = Array.isArray(d.raw?.pending_products) ? d.raw.pending_products : [];
      const noInventory = !!d.raw?.no_inventory;   // no afectar el stock
      const purchaseItems: any[] = [];
      for (const p of pending) {
        const { data: np, error: npErr } = await db.from('products').insert({
          tenant_id: tenantId,
          name: p.detail || 'Producto',
          sku: genReceptionSku(p.detail),
          cabys_code: p.cabys || null,
          cost_price: Number(p.unit_price) || 0,
          unit_price: Number(p.unit_price) || 0,
          stock_quantity: 0,
          tracks_stock: !noInventory,               // si "no añadir al inventario", no rastrea stock
        }).select('id').single();
        if (npErr) { messages.push(`No se pudo crear "${p.detail}": ${npErr.message}`); continue; }
        createdCount++;
        purchaseItems.push({
          product_id: (np as any).id,
          quantity: Number(p.quantity) || 1,
          unit_price: Number(p.unit_price) || 0,
          subtotal: (Number(p.quantity) || 1) * (Number(p.unit_price) || 0),
        });
      }
      if (createdCount) messages.push(`➕ ${createdCount} producto(s) creado(s).`);
      // Agregar los productos nuevos a la orden de compra ligada.
      if (purchaseItems.length && d.purchase_id) {
        await db.from('purchase_items').insert(purchaseItems.map(pi => ({ ...pi, purchase_id: d.purchase_id }))).then(() => {});
        const { data: ex } = await db.from('purchases').select('total_amount').eq('id', d.purchase_id).eq('tenant_id', tenantId).maybeSingle();
        const add = purchaseItems.reduce((s, pi) => s + pi.subtotal, 0);
        await db.from('purchases').update({ total_amount: Number((ex as any)?.total_amount ?? 0) + add, updated_at: new Date().toISOString() })
          .eq('id', d.purchase_id).eq('tenant_id', tenantId);
        messages.push(`🧾 ${purchaseItems.length} artículo(s) agregado(s) a la orden de compra.`);
      }
    }

    // Mensaje Receptor a Hacienda vía Alanube — OPCIONAL (best-effort). Si el
    // tenant no usa Alanube o falla, igual se marca aceptado/rechazado localmente.
    // Estructura confirmada contra el OAS de CRI (createReceiverMessage).
    let mrId: string | null = null;
    const isSandboxEnv = String(cfg.environment ?? 'production') === 'sandbox';
    const senderCompanyId = (isSandboxEnv ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id;
    if (cfg.fe_provider === 'alanube' && senderCompanyId) {
      const m5 = (n: any) => (Math.round(Number(n || 0) * 1e5) / 1e5).toFixed(5);
      const issuerId = String(d.issuer_id ?? '').replace(/\D/g, '');
      // Tipo de identificación del EMISOR original (proveedor): 9 díg = física, 10 = jurídica.
      const issuerType = issuerId.length === 9 ? '01' : issuerId.length >= 10 ? '02' : '02';
      // Consecutivo del mensaje receptor (por tenant): cantidad de MR ya enviados + 1.
      const { count: mrCount } = await db.from('received_documents')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).not('ack_id', 'is', null);
      const totalDoc = Number(d.total ?? 0);
      const taxDoc = Number(d.tax ?? 0);
      const payload: Record<string, any> = {
        idDoc: { key: String(d.clave ?? '').replace(/\D/g, '') },
        sender: { identification: { identificationType: issuerType, identificationNumber: issuerId } },
        receiver: {
          id: String(senderCompanyId),
          consecutiveNumber: {
            headquarters: String(cfg.sucursal ?? '1').replace(/\D/g, '').padStart(3, '0').slice(-3),
            terminal: String(cfg.terminal ?? '1').replace(/\D/g, '').padStart(5, '0').slice(-5),
            numberOfDocument: String((mrCount ?? 0) + 1),
          },
        },
        information: {
          message: st,                                   // 1 acepta · 2 parcial · 3 rechaza
          ...(st === '3' && reason ? { messageDetail: String(reason) } : {}),
          activityCode: String(cfg.economic_activity_code ?? '').trim(),
          taxCondition: '01',                            // 01 = genera crédito IVA
        },
        totals: {
          totalTaxCredit: m5(taxDoc),                    // IVA acreditable
          totalApplicableExpense: m5(totalDoc - taxDoc), // gasto aplicable (neto)
          totalTax: m5(taxDoc),
          totalVoucher: m5(totalDoc),
        },
      };
      try {
        const resp = await alanube.forEnv(cfg.environment).sendReceiverMessage(payload, String(senderCompanyId));
        mrId = resp?.id ?? deepFind(resp, /(^id$|_id$)/i, 40) ?? null;
      } catch (e: any) {
        messages.push(`⚠️ No se pudo enviar el mensaje a Hacienda (Alanube): ${e?.message ?? 'error'}. Se marcó localmente.`);
      }
    }

    // Limpiar pendientes y marcar el estado.
    const newRaw = { ...(d.raw ?? {}), pending_products: [] };
    await db.from('received_documents').update({
      ack_status: st === '1' ? 'accepted' : 'rejected', ack_id: mrId, raw: newRaw, updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId);

    return ok(c, { ok: true, state: st, mr_id: mrId, created: createdCount, messages });
  } catch (err: any) {
    const status = err instanceof AlanubeError ? err.status : 500;
    return fail(c, err.message, status);
  }
});

// POST /received — registra un comprobante de proveedor en la bandeja para luego
// enviarle el Mensaje Receptor. body: { clave, issuer_id, issuer_name?, total,
// tax?, doc_date?, document_type? }
hacienda.post('/received', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const cfg = await loadFEConfig(tenantId);
    if (cfg.fe_provider !== 'alanube') return fail(c, 'La recepción de comprobantes está disponible con Alanube.', 409);
    const b = await c.req.json().catch(() => ({}));
    const clave = String(b.clave ?? '').replace(/\D/g, '');
    if (clave.length !== 50) return fail(c, 'La clave debe tener 50 dígitos', 422);

    const { data, error } = await db.from('received_documents').upsert({
      tenant_id: tenantId,
      clave,
      issuer_name: b.issuer_name ?? null,
      issuer_id: String(b.issuer_id ?? '').replace(/\D/g, '') || null,
      document_type: b.document_type ?? clave.slice(29, 31),   // tipo va embebido en la clave
      doc_date: b.doc_date ?? new Date().toISOString(),
      total: Number(b.total ?? 0) || 0,
      tax: Number(b.tax ?? 0) || 0,
      ack_status: 'pending',
    }, { onConflict: 'tenant_id,clave' }).select().maybeSingle();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /received/classify — clasifica un recibido como 'gasto' o 'compra'.
// body: { id, kind: 'gasto' | 'compra' }
hacienda.post('/received/classify', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id, kind } = await c.req.json().catch(() => ({}));
    if (!id) return fail(c, 'Falta el id', 422);
    const k = kind === 'gasto' ? 'gasto' : kind === 'compra' ? 'compra' : null;
    const { error } = await db.from('received_documents')
      .update({ kind: k, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true, kind: k });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /received/to-purchase — convierte un recibido en una COMPRA a proveedor:
// busca/crea el proveedor y crea la compra (cabecera + artículos en notas).
// body: { id }
hacienda.post('/received/to-purchase', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = await c.req.json().catch(() => ({}));
    if (!id) return fail(c, 'Falta el id', 422);

    const { data: doc } = await db.from('received_documents')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!doc) return fail(c, 'Comprobante recibido no encontrado', 404);
    const d = doc as any;

    // 1. Proveedor: por cédula (tax_id) o nombre; si no existe, se crea.
    let supplierId: string | null = null;
    if (d.issuer_id) {
      const { data: s } = await db.from('suppliers').select('id')
        .eq('tenant_id', tenantId).eq('tax_id', d.issuer_id).maybeSingle();
      supplierId = (s as any)?.id ?? null;
    }
    if (!supplierId && d.issuer_name) {
      const { data: s } = await db.from('suppliers').select('id')
        .eq('tenant_id', tenantId).ilike('name', d.issuer_name).maybeSingle();
      supplierId = (s as any)?.id ?? null;
    }
    if (!supplierId) {
      const { data: created, error: sErr } = await db.from('suppliers')
        .insert({ tenant_id: tenantId, name: d.issuer_name || `Proveedor ${d.issuer_id ?? ''}`.trim(), tax_id: d.issuer_id ?? null })
        .select('id').single();
      if (sErr) throw new Error(sErr.message);
      supplierId = (created as any).id;
    }

    // 2. Compra (cabecera). Los artículos van en notas (sin ligar a productos/stock).
    const items: any[] = Array.isArray(d.items) ? d.items : [];
    const notas = items.length
      ? 'Artículos:\n' + items.map((it: any) => `• ${it.detail} — ${it.quantity} x ₡${Number(it.unit_price).toLocaleString('es-CR')} = ₡${Number(it.total).toLocaleString('es-CR')}`).join('\n')
      : `Comprobante recibido ${d.clave}`;
    const { data: purchase, error: pErr } = await db.from('purchases').insert({
      tenant_id: tenantId,
      supplier_id: supplierId,
      purchase_number: `REC-${String(d.clave).slice(-10)}`,
      purchase_date: (d.doc_date ? String(d.doc_date).slice(0, 10) : new Date().toISOString().slice(0, 10)),
      total_amount: Number(d.total ?? 0) || 0,
      notes: notas,
      status: 'pending',
    }).select('id').single();
    if (pErr) throw new Error(pErr.message);

    await db.from('received_documents').update({ kind: 'compra', updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId);
    return ok(c, { ok: true, purchase_id: (purchase as any).id, supplier_id: supplierId }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /received/:id/match — para el modal de "Compra": trae el comprobante con
// sus líneas ya emparejadas a productos existentes (por CABYS o por nombre), más
// las órdenes de compra PENDIENTES del proveedor para poder relacionarlas.
hacienda.get('/received/:id/match', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data: doc } = await db.from('received_documents')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!doc) return fail(c, 'Comprobante no encontrado', 404);
    const d = doc as any;
    const lines: any[] = linesFromDoc(d);

    // Proveedor (por cédula o nombre) para filtrar sus órdenes.
    let supplierId: string | null = null;
    if (d.issuer_id) {
      const { data: s } = await db.from('suppliers').select('id').eq('tenant_id', tenantId).eq('tax_id', d.issuer_id).maybeSingle();
      supplierId = (s as any)?.id ?? null;
    }
    if (!supplierId && d.issuer_name) {
      const { data: s } = await db.from('suppliers').select('id').eq('tenant_id', tenantId).ilike('name', d.issuer_name).maybeSingle();
      supplierId = (s as any)?.id ?? null;
    }

    const matchedLines = await matchLines(tenantId, lines);

    // Órdenes de compra pendientes del proveedor (para relacionar).
    let orders: any[] = [];
    if (supplierId) {
      const { data: os } = await db.from('purchases')
        .select('id, purchase_number, purchase_date, total_amount, status')
        .eq('tenant_id', tenantId).eq('supplier_id', supplierId)
        .in('status', ['pending', 'ordered']).order('purchase_date', { ascending: false }).limit(50);
      orders = (os ?? []) as any[];
    }

    return ok(c, {
      id: d.id, clave: d.clave, issuer_name: d.issuer_name, issuer_id: d.issuer_id,
      total: Number(d.total ?? 0), supplier_id: supplierId,
      lines: matchedLines, orders,
      linked_purchase_id: d.purchase_id ?? null,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /received/reconcile — aplica la conciliación desde el modal de "Compra":
//  · crea/actualiza productos (CABYS + precio de costo) de las líneas,
//  · crea una orden de compra nueva o agrega las líneas a una existente,
//  · marca el recibido como 'compra' y lo liga a esa compra.
// body: { id, purchase_id?, items: [{ detail, quantity, unit_price, cabys?,
//         product_id?, action: 'update'|'create'|'skip' }] }
hacienda.post('/received/reconcile', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({}));
    const { id, purchase_id, items, no_inventory } = body as {
      id: string; purchase_id?: string; no_inventory?: boolean;
      items?: Array<{ detail: string; quantity: number; unit_price: number; cabys?: string | null; product_id?: string | null; action: 'update' | 'create' | 'skip' }>;
    };
    if (!id) return fail(c, 'Falta el id', 422);

    const { data: doc } = await db.from('received_documents')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!doc) return fail(c, 'Comprobante no encontrado', 404);
    const d = doc as any;

    // Si el front no mandó items (o vinieron vacíos), los re-derivamos del XML.
    // Esto arregla el "0 artículos" cuando la bandeja no tenía las líneas.
    let workItems = Array.isArray(items) ? items : [];
    if (workItems.length === 0) {
      const matched = await matchLines(tenantId, linesFromDoc(d));
      workItems = matched.map((m: any) => ({
        detail: m.detail, quantity: m.quantity, unit_price: m.unit_price,
        cabys: m.cabys, product_id: m.product_id, action: (m.exists ? 'update' : 'create') as 'update' | 'create',
      }));
    }

    // Código COMERCIAL del proveedor (CodigoComercial del XML) por línea → se usa
    // como SKU del producto nuevo. Mapeado por detalle para no depender del front.
    const codeByDetail = new Map<string, string>();
    for (const l of linesFromDoc(d)) {
      const det = String(l.detail ?? l.Detalle ?? '').trim().toLowerCase();
      const code = String(l.code ?? l.Codigo ?? '').trim();
      if (det && code) codeByDetail.set(det, code);
    }

    // Proveedor: por cédula/nombre o se crea (resiliente a tax_id inexistente).
    let supplierId: string | null = null;
    if (d.issuer_id) {
      const { data: s } = await db.from('suppliers').select('id').eq('tenant_id', tenantId).eq('tax_id', d.issuer_id).maybeSingle();
      supplierId = (s as any)?.id ?? null;
    }
    if (!supplierId && d.issuer_name) {
      const { data: s } = await db.from('suppliers').select('id').eq('tenant_id', tenantId).ilike('name', d.issuer_name).maybeSingle();
      supplierId = (s as any)?.id ?? null;
    }
    if (!supplierId) {
      const name = d.issuer_name || `Proveedor ${d.issuer_id ?? ''}`.trim();
      let ins = await db.from('suppliers').insert({ tenant_id: tenantId, name, tax_id: d.issuer_id ?? null }).select('id').single();
      if (ins.error && /tax_id/.test(ins.error.message)) ins = await db.from('suppliers').insert({ tenant_id: tenantId, name }).select('id').single();
      if (ins.error) throw new Error(ins.error.message);
      supplierId = (ins.data as any).id;
    }

    const messages: string[] = [];
    let updated = 0, created = 0;
    const noInventory = !!no_inventory;
    const purchaseItems: any[] = [];

    for (const it of workItems) {
      if (it.action === 'skip') continue;
      let productId = it.product_id ?? null;
      const qty = Number(it.quantity) || 1;
      const price = Number(it.unit_price) || 0;

      if (it.action === 'update' && productId) {
        // Producto que COINCIDE (por código/nombre): actualizar CABYS/precio.
        const upd: any = { updated_at: new Date().toISOString() };
        if (it.cabys) upd.cabys_code = it.cabys;
        if (price > 0) upd.cost_price = price;
        const { error: uErr } = await db.from('products').update(upd).eq('id', productId).eq('tenant_id', tenantId);
        if (uErr) { messages.push(`⚠️ No se pudo actualizar "${it.detail}": ${uErr.message}`); }
        else { updated++; messages.push(`✏️ Actualizado (CABYS/precio): ${it.detail}`); }
      } else {
        // Producto NUEVO (el código NO coincide con ninguno interno): se CREA ahora
        // y se agrega a la orden de una vez (antes se difería y la orden quedaba vacía).
        // SKU = código comercial del XML si viene; si no, autogenerado.
        const xmlCode = codeByDetail.get(String(it.detail ?? '').trim().toLowerCase()) || '';
        const baseProd = {
          tenant_id: tenantId,
          name: it.detail || 'Producto',
          cabys_code: it.cabys || null,
          cost_price: price, unit_price: price,
          stock_quantity: 0, tracks_stock: !noInventory,
        };
        let ins = await db.from('products').insert({ ...baseProd, sku: xmlCode || genReceptionSku(it.detail) }).select('id').single();
        // Si el código del XML choca con un SKU ya existente, reintenta con uno único.
        if (ins.error && xmlCode && /duplicate|unique|sku/i.test(ins.error.message)) {
          ins = await db.from('products').insert({ ...baseProd, sku: genReceptionSku(it.detail) }).select('id').single();
        }
        const np = ins.data; const cErr = ins.error;
        if (cErr) { messages.push(`⚠️ No se pudo crear "${it.detail}": ${cErr.message}`); continue; }
        productId = (np as any).id;
        created++;
        messages.push(`➕ Creado como NUEVO: ${it.detail}`);
      }

      if (productId) {
        purchaseItems.push({ product_id: productId, quantity: qty, unit_price: price, subtotal: qty * price });
      }
    }

    // Orden de compra: relacionar existente o crear nueva.
    let purchaseId = purchase_id ?? null;
    let purchaseNumber = '';
    if (purchaseId) {
      // RECARGA idempotente: si se re-procesa la MISMA orden ya ligada a este
      // documento, se limpian sus items antes de re-insertar (evita duplicados y
      // rellena órdenes que quedaron vacías). Si es OTRA orden elegida, se agrega.
      const isReload = String(purchaseId) === String(d.purchase_id ?? '');
      if (isReload) {
        await db.from('purchase_items').delete().eq('purchase_id', purchaseId);
      }
      if (purchaseItems.length) {
        const { error: iErr } = await db.from('purchase_items').insert(purchaseItems.map(pi => ({ ...pi, purchase_id: purchaseId })));
        if (iErr) throw new Error(iErr.message);
      }
      const { data: existing } = await db.from('purchases').select('total_amount, purchase_number').eq('id', purchaseId).eq('tenant_id', tenantId).maybeSingle();
      purchaseNumber = String((existing as any)?.purchase_number ?? '');
      const addTotal = purchaseItems.reduce((s, pi) => s + pi.subtotal, 0);
      await db.from('purchases').update({
        total_amount: isReload ? addTotal : Number((existing as any)?.total_amount ?? 0) + addTotal,
        updated_at: new Date().toISOString(),
      }).eq('id', purchaseId).eq('tenant_id', tenantId);
      messages.push(isReload
        ? `🔄 Orden ${purchaseNumber} recargada con ${purchaseItems.length} artículo(s).`
        : `🔗 ${purchaseItems.length} artículo(s) agregado(s) a la orden ${purchaseNumber}.`);
    } else {
      const total = purchaseItems.reduce((s, pi) => s + pi.subtotal, 0) || Number(d.total ?? 0);
      purchaseNumber = await nextPurchaseNumber(tenantId);
      const { data: np, error: pErr } = await db.from('purchases').insert({
        tenant_id: tenantId,
        supplier_id: supplierId,
        purchase_number: purchaseNumber,
        purchase_date: (d.doc_date ? String(d.doc_date).slice(0, 10) : new Date().toISOString().slice(0, 10)),
        total_amount: total,
        status: 'pending',
        notes: `Recepción por correo · ${d.issuer_name ?? ''} · Clave ${d.clave}`,
      }).select('id').single();
      if (pErr) throw new Error(pErr.message);
      purchaseId = (np as any).id;
      if (purchaseItems.length) {
        const { error: iErr } = await db.from('purchase_items').insert(purchaseItems.map(pi => ({ ...pi, purchase_id: purchaseId })));
        if (iErr) throw new Error(iErr.message);
      }
      messages.push(`🧾 Orden de compra ${purchaseNumber} creada con ${purchaseItems.length} artículo(s).`);
    }

    // Resumen para el total a registrar.
    const totalReg = purchaseItems.reduce((s, pi) => s + pi.subtotal, 0);
    messages.unshift(`💰 Total registrado ₡${totalReg.toLocaleString('es-CR')} · ${updated} coincidencia(s) con CABYS/precio actualizado · ${created} producto(s) nuevo(s) creado(s).`);

    // Ya no se difieren productos: se crean/actualizan al conciliar (arriba). Se
    // deja pending_products vacío. Resiliente si la columna purchase_id no existe.
    const newRaw = { ...(d.raw ?? {}), pending_products: [], no_inventory: !!no_inventory };
    let upd = await db.from('received_documents')
      .update({ kind: 'compra', purchase_id: purchaseId, raw: newRaw, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId);
    if (upd.error && /purchase_id/.test(upd.error.message)) {
      upd = await db.from('received_documents')
        .update({ kind: 'compra', raw: newRaw, updated_at: new Date().toISOString() })
        .eq('id', id).eq('tenant_id', tenantId);
    }

    return ok(c, { ok: true, purchase_id: purchaseId, purchase_number: purchaseNumber, updated, created, items: purchaseItems.length, total: totalReg, messages }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /received/upload — registra un recibido a partir del XML del proveedor.
// body: { xml: string }  (contenido del archivo .xml de la factura del proveedor)
hacienda.post('/received/upload', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const cfg = await loadFEConfig(tenantId);
    if (cfg.fe_provider !== 'alanube') return fail(c, 'La recepción de comprobantes está disponible con Alanube.', 409);
    const { xml } = await c.req.json().catch(() => ({}));
    if (!xml || typeof xml !== 'string') return fail(c, 'Falta el contenido del XML', 422);

    // Extracción por etiqueta (FE CR v4.4). Las etiquetas no llevan prefijo de ns.
    const tag = (src: string, name: string): string => {
      const m = src.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    const clave = tag(xml, 'Clave').replace(/\D/g, '');
    if (clave.length !== 50) return fail(c, 'El XML no tiene una Clave válida de 50 dígitos. ¿Es un comprobante electrónico de Hacienda?', 422);

    const emisor = tag(xml, 'Emisor');
    const emisorNombre = tag(emisor, 'Nombre');
    const emisorId = tag(tag(emisor, 'Identificacion'), 'Numero').replace(/\D/g, '');
    const resumen = tag(xml, 'ResumenFactura');
    const total = Number(tag(resumen, 'TotalComprobante') || tag(xml, 'TotalComprobante') || 0) || 0;
    const tax = Number(tag(resumen, 'TotalImpuesto') || tag(xml, 'TotalImpuesto') || 0) || 0;
    const fecha = tag(xml, 'FechaEmision') || new Date().toISOString();

    // Artículos comprados: cada <LineaDetalle> del <DetalleServicio>.
    const items: any[] = [];
    const lineRe = /<LineaDetalle[^>]*>([\s\S]*?)<\/LineaDetalle>/gi;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(xml)) !== null) {
      const l = lm[1];
      items.push({
        detail: tag(l, 'Detalle'),
        quantity: Number(tag(l, 'Cantidad') || 0) || 0,
        unit: tag(l, 'UnidadMedida') || null,
        cabys: tag(l, 'CodigoCABYS') || tag(l, 'Codigo') || null,
        unit_price: Number(tag(l, 'PrecioUnitario') || 0) || 0,
        total: Number(tag(l, 'MontoTotalLinea') || tag(l, 'SubTotal') || tag(l, 'MontoTotal') || 0) || 0,
      });
    }

    const { data, error } = await db.from('received_documents').upsert({
      tenant_id: tenantId,
      clave,
      issuer_name: emisorNombre || null,
      issuer_id: emisorId || null,
      document_type: clave.slice(29, 31),   // tipo embebido en la clave
      doc_date: fecha,
      total, tax,
      items: items.length ? items : null,
      ack_status: 'pending',
      raw: { xml: xml.slice(0, 20000) },
    }, { onConflict: 'tenant_id,clave' }).select().maybeSingle();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /resend-email — reenvía la info del comprobante a OTRO correo.
// body: { invoice_id, email }
// Baja de Alanube el XML del comprobante, el XML de respuesta de Hacienda y el
// PDF, y arma los adjuntos del correo. Tolerante a fallos (devuelve lo que haya).
// Baja el contenido de una URL (XML/PDF que Alanube entrega como enlace) y lo
// devuelve en base64. null si falla.
async function fetchToBase64(url: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length ? buf.toString('base64') : null;
  } catch { return null; }
}

// Convierte un valor del comprobante a base64: URL → se descarga; XML crudo →
// base64; ya-base64 → tal cual.
async function toB64(v: any): Promise<string | null> {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return await fetchToBase64(s);
  return s.startsWith('<') ? Buffer.from(s, 'utf8').toString('base64') : s;
}

async function alanubeAttachments(cfg: any, docId: string | null | undefined, kind: any, clave: string, companyId?: string | null): Promise<Array<{ filename: string; content: string }>> {
  const out: Array<{ filename: string; content: string }> = [];
  if (!docId) return out;
  const client = alanube.forEnv(cfg.environment);
  const base = String(clave || docId);

  // 1) XML original + XML de respuesta de Hacienda. CRI los devuelve como URL en
  //    los campos xml / xmlHacienda (separador de guiones). Hay que descargarlos.
  try {
    const resp: any = await client.getDocument(String(docId), { kind, documents: 'xml-xmlHacienda' });
    const d = resp?.invoice ?? resp?.ticket ?? resp?.creditNote ?? resp?.debitNote ?? resp?.document ?? resp?.data ?? resp;
    const xml = await toB64(d?.xml ?? deepFind(resp, /^xml$/i, 8_000_000));
    const xmlHac = await toB64(d?.xmlHacienda ?? deepFind(resp, /xmlhacienda/i, 8_000_000));
    if (xml) out.push({ filename: `${base}.xml`, content: xml });
    if (xmlHac) out.push({ filename: `${base}-respuesta-hacienda.xml`, content: xmlHac });
  } catch (e: any) { console.warn('[FE email] XML no disponible:', e?.message); }

  // 2) PDF por el endpoint dedicado (base64). Requiere idCompany.
  try {
    if (companyId) {
      const r: any = await client.getDocumentPdf(String(docId), String(kind), String(companyId));
      const pdf = await toB64(r?.pdf ?? deepFind(r, /^pdf$/i, 12_000_000));
      if (pdf) out.push({ filename: `${base}.pdf`, content: pdf });
    }
  } catch (e: any) { console.warn('[FE email] PDF no disponible:', e?.message); }

  return out;
}

/** Arma y envía el correo del comprobante electrónico con XML/PDF adjuntos. */
async function sendComprobanteEmail(to: string, i: {
  invoice_number: string; fe_clave: string; fe_consecutivo?: string | null;
  fe_status?: string | null; total?: number | null; customer_name?: string | null; fe_xml?: string | null;
}, attachments?: Array<{ filename: string; content: string }>): Promise<void> {
  const estado = i.fe_status === 'accepted' ? 'Aceptado' : i.fe_status === 'rejected' ? 'Rechazado' : 'En proceso';
  const html = `
    <div style="font-family:sans-serif;font-size:14px;color:#222">
      <h2>Comprobante electrónico ${i.invoice_number}</h2>
      <p><b>Cliente:</b> ${i.customer_name ?? '—'}</p>
      <p><b>Estado Hacienda:</b> ${estado}</p>
      <p><b>Consecutivo:</b> ${i.fe_consecutivo ?? '—'}</p>
      <p><b>Clave:</b> ${i.fe_clave}</p>
      <p><b>Total:</b> ₡${Number(i.total ?? 0).toLocaleString('es-CR')}</p>
    </div>`;
  // Adjuntos: los pasados (Alanube) o, si no hay, el fe_xml guardado.
  let atts = attachments && attachments.length ? attachments : undefined;
  if (!atts && i.fe_xml) {
    atts = [{ filename: `${i.fe_clave}.xml`, content: Buffer.from(String(i.fe_xml), 'utf8').toString('base64') }];
  }
  await sendEmail({ to, subject: `Comprobante electrónico ${i.invoice_number}`, html, attachments: atts });
}

// Envía AUTOMÁTICAMENTE el comprobante COMPLETO (XML + respuesta de Hacienda +
// PDF) al correo del cliente. Se llama al ACEPTARSE la factura. Marca la factura
// para no reenviar (fe_emailed) en cada refresco.
export async function autoSendComprobanteToCustomer(tenantId: string, invoiceId: string): Promise<void> {
  try {
    const cfg = await loadFEConfig(tenantId);
    const { data: inv } = await db.from('invoices')
      .select('invoice_number, fe_clave, fe_consecutivo, fe_status, fe_xml, total, customer_name, customer_id, document_type, fe_emailed')
      .eq('id', invoiceId).eq('tenant_id', tenantId).maybeSingle();
    if (!inv || (inv as any).fe_emailed) return;   // ya se envió
    let email: string | null = null;
    if ((inv as any).customer_id) {
      const { data: cust } = await db.from('customers').select('email').eq('id', (inv as any).customer_id).maybeSingle();
      email = (cust as any)?.email ?? null;
    }
    if (!email) return;   // sin correo del cliente, no se envía
    const atts = cfg.fe_provider === 'alanube'
      ? await alanubeAttachments(cfg, (inv as any).fe_consecutivo, feKindOf((inv as any).document_type), (inv as any).fe_clave,
          (String(cfg.environment ?? 'production') === 'sandbox' ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id)
      : undefined;
    await sendComprobanteEmail(email, inv as any, atts);
    await db.from('invoices').update({ fe_emailed: true }).eq('id', invoiceId).eq('tenant_id', tenantId).then(() => {}, () => {});
  } catch (e: any) { console.warn('[FE email auto-accept] no se pudo enviar:', e?.message); }
}

hacienda.post('/resend-email', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { invoice_id, email } = await c.req.json().catch(() => ({}));
    if (!invoice_id || !email) return fail(c, 'Falta invoice_id o email', 422);

    const { data: inv } = await db.from('invoices')
      .select('invoice_number, fe_clave, fe_consecutivo, fe_status, fe_xml, total, customer_name, document_type')
      .eq('id', invoice_id).eq('tenant_id', tenantId).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    if (!(inv as any).fe_clave) return fail(c, 'La factura no fue emitida electrónicamente', 422);

    // Con Alanube, bajamos XML + respuesta de Hacienda + PDF para adjuntar.
    const cfg = await loadFEConfig(tenantId);
    const attachments = cfg.fe_provider === 'alanube'
      ? await alanubeAttachments(cfg, (inv as any).fe_consecutivo, feKindOf((inv as any).document_type), (inv as any).fe_clave,
          (String(cfg.environment ?? 'production') === 'sandbox' ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id)
      : undefined;
    await sendComprobanteEmail(email, inv as any, attachments);
    // Marca que el comprobante ya se envió por correo (para el check en la bitácora).
    await db.from('invoices').update({ fe_emailed: true }).eq('id', invoice_id).eq('tenant_id', tenantId).then(() => {}, () => {});
    return ok(c, { ok: true, attachments: attachments?.length ?? 0 });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /fe-pdf/:id — devuelve el PDF que genera ALANUBE (en base64) para abrirlo
// tal cual desde el botón "PDF". Solo aplica a comprobantes emitidos con Alanube.
hacienda.get('/fe-pdf/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data: inv } = await db.from('invoices')
      .select('fe_consecutivo, fe_clave, document_type')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    const docId = (inv as any).fe_consecutivo;
    if (!docId) return fail(c, 'Este comprobante no tiene documento en Alanube', 404);

    const cfg = await loadFEConfig(tenantId);
    const companyId = (String(cfg.environment ?? 'production') === 'sandbox'
      ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id;
    if (!companyId) return fail(c, 'La empresa no está registrada en Alanube', 422);
    const resp: any = await alanube.forEnv(cfg.environment)
      .getDocumentPdf(String(docId), feKindOf((inv as any).document_type), String(companyId));
    const pdf = await toB64(resp?.pdf ?? deepFind(resp, /^pdf$/i, 12_000_000));
    if (!pdf) return fail(c, 'PDF no disponible en Alanube todavía', 404);
    return ok(c, { pdf, filename: `${(inv as any).fe_clave || id}.pdf` });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** Próximo consecutivo simple (000001…). */
async function nextInvoiceNumber(tenantId: string, offset = 0): Promise<string> {
  const { data } = await db.from('invoices').select('invoice_number').eq('tenant_id', tenantId);
  let maxSeq = 0;
  for (const r of (data ?? []) as any[]) {
    const s = String(r.invoice_number ?? '').trim();
    if (/^\d{1,6}$/.test(s)) maxSeq = Math.max(maxSeq, parseInt(s, 10));
  }
  return String(maxSeq + 1 + offset).padStart(6, '0');
}

// POST /emit-direct — crea la factura desde el carrito (con precio e IVA por
// línea editables) y la emite a Hacienda en un solo paso. Para el POS de FE.
// body: { document_type, payment_method, session_id?, notes?, customer?, lines[] }
//   lines[]: { product_id, name, sku?, quantity, unit_price, iva_rate, cabys_code?, unit? }
hacienda.post('/emit-direct', async (c) => {
  const tenantId = c.get('tenantId');
  try {
    const b = await c.req.json().catch(() => ({}));
    const rawLines: any[] = Array.isArray(b.lines) ? b.lines : [];
    if (rawLines.length === 0) return fail(c, 'No hay líneas para facturar', 422);

    const cfg = await loadFEConfig(tenantId);
    if (!cfg.enabled) return fail(c, 'La facturación electrónica no está activada', 409);
    const provider = cfg.fe_provider === 'alanube' ? 'alanube' : 'facturemos';
    if (provider === 'facturemos' && !cfg.api_key_emisor) return fail(c, 'Falta configurar la ApiKey del emisor', 422);
    const alanubeCompanyId = (String(cfg.environment ?? 'production') === 'sandbox'
      ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id;
    if (provider === 'alanube' && !alanubeCompanyId) return fail(c, 'La empresa no está dada de alta en Alanube.', 422);
    const env = cfg.environment === 'sandbox' ? 'sandbox' : 'production'; // default producción
    const defaultCabys = String(cfg.default_cabys ?? '').replace(/\D/g, '') || null;

    // Excluir de la FE los productos marcados "no enviar a Hacienda" (sin precio).
    // Se mantienen en la venta (invoice_items) pero NO van en el comprobante.
    const linePids = [...new Set(rawLines.map((l: any) => l.product_id).filter(Boolean))];
    const excludedFe = new Set<string>();
    if (linePids.length > 0) {
      const { data: exProds } = await db.from('products')
        .select('id, exclude_from_fe').in('id', linePids as string[]);
      for (const p of (exProds ?? []) as any[]) if (p.exclude_from_fe) excludedFe.add(p.id);
    }
    const feRawLines = rawLines.filter((l: any) =>
      Number(l.unit_price) > 0 && !(l.product_id && excludedFe.has(l.product_id)));

    // Normalizar líneas + totales.
    const lines: FELine[] = feRawLines.map((l: any) => {
      const qty = Number(l.quantity) || 0;
      const price = Number(l.unit_price) || 0;
      const sub = Math.round(qty * price * 100) / 100;
      return {
        product_name: l.name ?? 'Producto',
        sku: l.sku ?? null,
        quantity: qty,
        unit_price: price,
        subtotal: sub,
        cabys_code: (l.cabys_code ? String(l.cabys_code).replace(/\D/g, '') : '') || defaultCabys,
        iva_rate: Number(l.iva_rate ?? 0),
        unit: l.unit ?? 'Unid',
      };
    }).filter((l: FELine) => l.quantity > 0);
    if (lines.length === 0) return fail(c, 'No hay líneas válidas', 422);

    const sinCabys = lines.filter(l => !l.cabys_code);
    if (sinCabys.length > 0) {
      const nombres = [...new Set(sinCabys.map(l => l.product_name))].join(', ');
      return fail(c, `Estos productos no tienen código CABYS: ${nombres}. Asignáselo en el producto.`, 422);
    }

    const subtotal = lines.reduce((s, l) => s + l.subtotal, 0);
    const taxAmount = lines.reduce((s, l) => s + Math.round(l.subtotal * (Number(l.iva_rate) / 100) * 100) / 100, 0);
    const total = Math.round((subtotal + taxAmount) * 100) / 100;

    // Receptor.
    const receptor = b.customer && (b.customer.identification || b.customer.name)
      ? {
          name: b.customer.name, identification_type: b.customer.identification_type,
          identification: b.customer.identification, email: b.customer.email,
          province_code: b.customer.province_code, canton_code: b.customer.canton_code,
          district_code: b.customer.district_code, address: b.customer.address,
        }
      : null;
    const receptorConCedula = !!(receptor?.identification && receptor?.identification_type);
    const tipoDoc = b.document_type === 'factura_electronica' ? '01' : '04';
    if (tipoDoc === '01' && !receptorConCedula) {
      return fail(c, 'Para Factura Electrónica el cliente debe tener cédula. Seleccioná un cliente con identificación o emití como tiquete.', 422);
    }
    const docType = tipoDoc === '01' ? 'factura_electronica' : 'tiquete_electronico';
    const payment: string = ['cash', 'card', 'sinpe', 'credit'].includes(b.payment_method) ? b.payment_method : 'cash';

    // Crear factura (consecutivo único).
    let inv: any = null, invErr: any = null, finalNumber = await nextInvoiceNumber(tenantId);
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await db.from('invoices').insert({
        tenant_id: tenantId,
        cash_session_id: b.session_id ?? null,
        invoice_number: finalNumber,
        subtotal, discount_amount: 0, tax_amount: taxAmount, total,
        payment_method: payment,
        customer_id: b.customer?.id ?? null,
        customer_name: b.customer?.name ?? null,
        document_type: docType,
        notes: b.notes ?? null,
        issued_at: b.issued_at ?? new Date().toISOString(),
      }).select().single();
      if (!res.error) { inv = res.data; break; }
      invErr = res.error;
      if (!(String(invErr?.code) === '23505' || /duplicate/i.test(invErr?.message ?? ''))) break;
      finalNumber = await nextInvoiceNumber(tenantId, attempt + 1);
    }
    if (!inv) throw new Error(invErr?.message ?? 'No se pudo crear la factura');

    await db.from('invoice_items').insert(rawLines
      .filter((l: any) => l.product_id && Number(l.quantity) > 0)
      .map((l: any) => ({
        invoice_id: inv.id, product_id: l.product_id, quantity: Number(l.quantity),
        unit_price: Number(l.unit_price) || 0, discount_percent: 0, discount_amount: 0,
        subtotal: Math.round((Number(l.quantity) || 0) * (Number(l.unit_price) || 0) * 100) / 100,
      })));

    // Emitir a Hacienda.
    const emisor = {
      identification_type: cfg.emisor_identification_type ?? '02', identification: cfg.emisor_identification ?? '',
      name: cfg.emisor_name ?? '', commercial_name: cfg.emisor_commercial_name ?? '',
      province_code: cfg.emisor_province_code ?? '', canton_code: cfg.emisor_canton_code ?? '',
      district_code: cfg.emisor_district_code ?? '', address: cfg.emisor_address ?? '',
      phone: cfg.emisor_phone ?? '', email: cfg.emisor_email ?? '',
      economic_activity_code: cfg.economic_activity_code ?? '',
      proveedor_sistemas: (await globalProveedorSistemas()) || cfg.proveedor_sistemas || '',
    };
    const invForDoc = { invoice_number: inv.invoice_number, issued_at: inv.issued_at, payment_method: payment, document_type: docType, total };

    // ── Proveedor ALANUBE ─────────────────────────────────────────────────────
    if (provider === 'alanube') {
      const kind = tipoDoc === '01' ? 'invoice' : 'ticket';
      const doc = buildAlanubeDocument(emisor, invForDoc as any, lines, receptor as any, {
        tipoDoc,
        headquarters: cfg.sucursal, terminal: cfg.terminal,
        numberOfDocument: inv.invoice_number,
        // Empresa emisora del tenant (si no, Alanube usa la 'main' de la cuenta).
        senderId: (String(cfg.environment ?? 'production') === 'sandbox'
          ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id,
      });
      try {
        const resp: any = await alanube.forEnv(cfg.environment).emitDocument(kind as any, doc, cfg.alanube_company_id);
        const docObj = resp?.ticket ?? resp?.invoice ?? resp?.document ?? resp?.data ?? resp;
        const docId = docObj?.id ?? deepFind(resp, /(^id$|_id$|documentId$)/i, 10) ?? null;
        const clave = docObj?.key ?? docObj?.clave ?? deepFind(resp, /(clave|^key$)/i, 40) ?? null;
        const alanubeStatus = docObj?.status ?? null;
        await db.from('invoices').update({
          fe_clave: clave ?? docId, fe_consecutivo: docId, fe_status: 'sent', fe_situacion: '1', fe_environment: env, fe_error: null,
          fe_request: doc, fe_response: resp,
          updated_at: new Date().toISOString(),
        }).eq('id', inv.id).eq('tenant_id', tenantId);
        // El correo al cliente sale automáticamente al ACEPTARSE (dos XML + PDF).
        return ok(c, { ok: true, provider: 'alanube', invoice_id: inv.id, invoice_number: inv.invoice_number, clave, alanube_doc_id: docId, alanube_status: alanubeStatus, tipo: tipoDoc });
      } catch (emitErr: any) {
        const msg = emitErr instanceof AlanubeError ? emitErr.message : (emitErr?.message ?? 'Error emitiendo con Alanube');
        await db.from('invoices').update({ fe_status: 'error', fe_error: msg }).eq('id', inv.id).eq('tenant_id', tenantId);
        return fail(c, msg, 422);
      }
    }

    // ── Proveedor FACTUREMOS ──────────────────────────────────────────────────
    const consecutivo = buildConsecutivo(invForDoc as any, { sucursal: cfg.sucursal, terminal: cfg.terminal, situacion: '1', tipoComprobante: tipoDoc });
    const facturaJson = buildDocumentoJson(emisor, invForDoc as any, lines, receptor as any, { tipoComprobante: tipoDoc });

    try {
      const resp = await enviaDocumentoConsecutivoJson(env, cfg.api_key_emisor, facturaJson, consecutivo);
      const clave = typeof resp === 'string' ? resp : (resp?.Clave ?? resp?.clave ?? null);
      const consec = typeof resp === 'object' ? (resp?.Consecutivo ?? resp?.NumeroConsecutivo ?? null) : null;
      await db.from('invoices').update({
        fe_clave: clave, fe_consecutivo: consec, fe_status: 'sent', fe_situacion: '1', fe_environment: env,
        updated_at: new Date().toISOString(),
      }).eq('id', inv.id).eq('tenant_id', tenantId);
      return ok(c, { ok: true, invoice_id: inv.id, invoice_number: inv.invoice_number, clave, consecutivo: consec, tipo: tipoDoc });
    } catch (emitErr: any) {
      const friendly = friendlyFEError(emitErr.message);
      await db.from('invoices').update({ fe_status: 'error', fe_error: friendly }).eq('id', inv.id).eq('tenant_id', tenantId);
      return fail(c, friendly, emitErr instanceof FacturemosError ? emitErr.status : 500);
    }
  } catch (err: any) {
    return fail(c, friendlyFEError(err.message), 500);
  }
});

// Alias legado.
hacienda.post('/cancel', (c: any) => c.json({ data: null, error: 'Usá /credit-note' }, 400));

export default hacienda;
