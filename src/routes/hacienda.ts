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
import { notifyFeError, notifyQuotaLow } from '../services/whatsappNotify.js';

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

// Empareja líneas del comprobante con productos del tenant (por CABYS, código/SKU
// o nombre). Ignora los productos ocultos (soft-deleted).
// Algunos proveedores meten datos internos en el <Detalle> separados por ';'
// (ej. "Casco KOV RACING L;32100.98;24;;P001688;24396.74"). Nos quedamos con el
// NOMBRE real: todo lo anterior al primer ';' seguido de un número.
//
// Otros anteponen su código entre corchetes —"[MXP39] PIÑON TRASERO XL125 38T"—,
// y no lo hacen en todas las líneas, así que en una misma compra unos productos
// entraban limpios y otros con el código pegado al nombre. Ese código ya se
// guarda aparte como SKU (viene en <Codigo>), así que en el nombre solo estorba:
// además rompe el emparejamiento por nombre, y el mismo artículo vuelve a
// crearse como nuevo en la siguiente compra.
//
// El corchete se quita solo si va al PRINCIPIO, si adentro hay algo con pinta de
// código (sin espacios) y si después queda nombre de verdad. Un "[2 UNIDADES]"
// o un nombre que sea solo el corchete se dejan como están.
const SUPPLIER_CODE_PREFIX = /^\[[A-Za-z0-9][A-Za-z0-9._/+-]*\]\s*/;

function cleanReceptionDetail(s: any): string {
  const str = String(s ?? '').trim();
  const m = str.match(/^(.*?);\s*\d/);
  let out = (m ? m[1] : str).trim();
  const stripped = out.replace(SUPPLIER_CODE_PREFIX, '').trim();
  if (stripped) out = stripped;
  return out;
}

async function matchLines(tenantId: string, lines: any[]): Promise<any[]> {
  let sel: any = await db.from('products')
    .select('id, name, cabys_code, sku, tracks_stock').eq('tenant_id', tenantId).is('deleted_at', null).limit(5000);
  if (sel.error && /deleted_at/.test(sel.error.message ?? '')) {   // migración 58 sin correr
    sel = await db.from('products').select('id, name, cabys_code, sku, tracks_stock').eq('tenant_id', tenantId).limit(5000);
  }
  const products = sel.data ?? [];
  const byCabys = new Map<string, any>(), bySku = new Map<string, any>(), byName = new Map<string, any>();
  for (const p of products as any[]) {
    if (p.cabys_code) byCabys.set(String(p.cabys_code), p);
    if (p.sku) bySku.set(String(p.sku).trim().toLowerCase(), p);
    if (p.name) byName.set(String(p.name).trim().toLowerCase(), p);
  }
  return lines.map((l: any) => {
    const cabys = String(l.cabys ?? l.CodigoCABYS ?? '');
    const code = String(l.code ?? l.Codigo ?? '').trim();
    const detail = cleanReceptionDetail(l.detail ?? l.Detalle);
    // Coincidencia por: 1) CABYS, 2) código comercial == SKU interno, 3) nombre.
    const mCabys = cabys ? byCabys.get(cabys) : null;
    const mSku = !mCabys && code ? bySku.get(code.toLowerCase()) : null;
    const mName = !mCabys && !mSku ? byName.get(detail.trim().toLowerCase()) : null;
    const match = mCabys || mSku || mName || null;
    return {
      detail,
      quantity: Number(l.quantity ?? l.Cantidad ?? 1),
      unit_price: Number(l.unit_price ?? l.PrecioUnitario ?? 0),
      // Total de línea = NETO (con descuento). Priorizamos SubTotal sobre
      // total/MontoTotal (que suelen ser el BRUTO, antes del descuento).
      total: Number(l.subtotal ?? l.SubTotal ?? l.total ?? l.MontoTotal ?? 0),
      cabys: cabys || null,
      code: code || null,   // código comercial del XML
      product_id: match?.id ?? null,
      product_name: match?.name ?? null,
      exists: !!match,
      matched_by: mCabys ? 'cabys' : mSku ? 'sku' : mName ? 'name' : null,   // cómo coincidió
      // El producto que coincidió NO lleva control de stock (infinito). Se informa
      // para que el modal lo muestre y quede claro que la compra no lo cambia.
      infinite: match ? (match as any).tracks_stock === false : false,
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
export async function loadFEConfig(tenantId: string): Promise<any> {
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

// Umbrales de "comprobantes por acabarse": se avisa al CRUZAR cada uno (una vez
// por umbral, no en cada emisión). Solo aplica a bolsas limitadas (included > 0).
const QUOTA_ALERT_THRESHOLDS = [50, 20, 10, 5, 1];

// Aviso de cuota baja tras una emisión exitosa (fire-and-forget). Como cada
// emisión baja `available` en ~1, notificar cuando cae exactamente en un umbral
// dispara ~una vez por umbral.
async function maybeNotifyQuotaLow(tenantId: string): Promise<void> {
  try {
    const q = await computeFeQuota(tenantId);
    if (q.included > 0 && q.available !== null && QUOTA_ALERT_THRESHOLDS.includes(q.available)) {
      void notifyQuotaLow(tenantId, q.available, q.included).catch(() => {});
    }
  } catch { /* ignore */ }
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

/** Traduce los errores de validación de Alanube (400) a mensajes claros.
 *  Exportada para reusarla desde la pasarela de FE externa (feExternal.ts). */
export function friendlyAlanubeError(raw: string): string {
  const s = String(raw || '');
  // Detalle después de "Alanube respondió 400 — ..." (o el mensaje entero).
  const detail = s.replace(/^alanube respondi[oó]\s*\d+\s*[—:-]\s*/i, '').trim();
  const l = detail.toLowerCase();
  const map: Array<[RegExp, string]> = [
    // Control de numeración de Alanube (changelog CRI): valida la combinación
    // «cédula de la empresa + consecutivo». Confirma que el consecutivo lo manda
    // el emisor, no Alanube — si lo generara ella, no tendría nada que validar.
    [/ap3018|numeration was already used/i,
      'Ese consecutivo YA se usó para esta empresa. La numeración la manda el sistema, no Alanube: '
      + 'corregí el "Próximo consecutivo" del tipo de comprobante en Datos de FE y volvé a emitir.'],
    [/ap3017|numeration is already in process/i,
      'Ese consecutivo está siendo procesado en este momento (otro envío con el mismo número). '
      + 'Esperá unos segundos y consultá el estado antes de reintentar: puede que ya haya salido.'],
    [/otrassenas.*at least 5|otrassenas.*5 characters/i, 'La dirección del cliente (otras señas) debe tener al menos 5 caracteres. Completá la dirección del cliente.'],
    [/receiver\.address|address\.(province|canton|district)/i, 'La dirección del cliente es inválida (provincia/cantón/distrito/señas). Revisá los datos del cliente.'],
    // Los errores del SENDER van ANTES que los del receptor: sin esto un problema
    // del emisor se reportaba como "identificación del cliente" y despistaba.
    [/sender:.*additional properties|sender\.(identification|name|tradename|economicactivity)/i,
      'Alanube no acepta datos del emisor dentro del comprobante: la cédula y el certificado con que sale '
      + 'son los de la empresa registrada en Alanube. Para cambiarlos hay que corregir esa empresa.'],
    [/receiver\.identification|identificationnumber|identificationtype/i, 'La identificación del cliente (cédula) no corresponde al tipo seleccionado (física/jurídica/DIMEX).'],
    [/receiver\.email|receiver\.name/i, 'Faltan o son inválidos los datos del cliente (nombre o correo).'],
    [/sendereconomicactivity|economicactivity/i, 'La actividad económica del emisor es inválida o falta en los Datos de FE.'],
    [/company not found|sender\.id|main company/i, 'La empresa emisora no está registrada en Alanube en este ambiente. Volvé a crear/activar la empresa.'],
    [/totaltaxbreakdown|totals\.|totaltaxable|totaltax/i, 'Hay un descuadre en los totales del comprobante. Revisá precios e IVA de las líneas.'],
    [/cabys|itemdetails\.\d+\.code/i, 'Un producto tiene un código CABYS inválido o vacío. Asignáselo en Inventario.'],
    [/unitmeasurement/i, 'La unidad de medida de un producto no es válida para Hacienda.'],
    [/amount.*not equal|taxablebase.*fee|amounttotalline/i, 'Los montos de una línea no cuadran (base × IVA). Revisá el precio o la tarifa del producto.'],
    [/consecutiv|numberofdocument/i, 'Problema con la numeración consecutiva del comprobante.'],
    [/at least (\d+) characters/i, 'Un dato del comprobante es más corto de lo permitido.'],
    // "Invalid credentials … hacienda system" NO es el token de Alanube: son el
    // usuario y la contraseña de API que se generan en ATV, propios de CADA cédula.
    [/invalid credentials.*hacienda|data supplied to connect to the hacienda/i,
      'Las credenciales de ATV (Hacienda) del emisor son inválidas. En «Datos de FE» revisá '
      + '«Usuario de API de ATV» y «Contraseña de API de ATV» del ambiente activo: se generan en ATV '
      + 'para ESA cédula y no son el PIN del certificado .p12.'],
    [/invalid credentials|unauthorized|token/i, 'Error de autenticación con Alanube. Revisá el token del ambiente.'],
  ];
  for (const [re, friendly] of map) if (re.test(l)) return `${friendly}\n(Detalle técnico: ${detail})`;
  return detail ? `Alanube rechazó el comprobante: ${detail}` : s;
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

/** Hacienda rechaza con código -99 cuando el CONSECUTIVO ya se usó antes (típico al
 *  migrar desde otro sistema: el emisor ya quemó números con el proveedor anterior).
 *  El mensaje trae el consecutivo de 20 díg: "La numeración consecutiva
 *  00100001010000000085 del comprobante … ya existe … desde el día 16-08-2023".
 *  Acá lo leemos, sacamos el número (últimos 10 díg) y SUBIMOS el piso configurado en
 *  Datos de FE a ese+1, para que la próxima emisión no vuelva a chocar. Devuelve el
 *  nuevo piso, o null si el rechazo no fue por consecutivo duplicado. */
export async function bumpConsecutivoOnDuplicate(
  tenantId: string, cfg: any, docType: string | null | undefined, errText: any,
): Promise<number | null> {
  const s = String(errText ?? '');
  if (!/-99/.test(s) || !/numeraci[oó]n consecutiva/i.test(s)) return null;
  // Todos los consecutivos de 20 díg del mensaje (puede citar más de uno): usamos el mayor.
  const found = [...s.matchAll(/\b(\d{20})\b/g)].map(m => parseInt(m[1].slice(-10), 10))
    .filter(n => Number.isFinite(n) && n > 0);
  if (found.length === 0) return null;
  const nextFloor = Math.max(...found) + 1;

  const key = docType === 'factura_electronica' ? 'consecutivo_factura'
    : docType === 'tiquete_electronico' ? 'consecutivo_tiquete'
    : (docType === 'nota_credito' || docType === 'nota_debito') ? 'consecutivo_nc'
    : null;
  if (!key) return null;
  const current = configuredNextConsecutivo(cfg, String(docType));
  if (current >= nextFloor) return null;   // el piso configurado ya es suficiente

  try {
    const { data: prev } = await db.from('settings').select('config')
      .eq('tenant_id', tenantId).eq('type', 'electronic-invoice').maybeSingle();
    const merged = { ...((prev?.config as any) ?? {}), [key]: String(nextFloor) };
    await db.from('settings').upsert({
      tenant_id: tenantId, type: 'electronic-invoice', config: merged,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' });
    console.warn(`[fe] consecutivo duplicado (-99) en ${tenantId}: ${key} → ${nextFloor}`);
    return nextFloor;
  } catch (e: any) {
    console.warn('[fe] no se pudo subir el consecutivo:', e?.message);
    return null;
  }
}

/** Terminal (caja) del EQUIPO que está facturando.
 *  Viene en el header `x-terminal`; si no, la configurada del tenant. Es lo que
 *  permite que dos computadoras facturen a la vez sin repetir consecutivo: el
 *  consecutivo de Hacienda lleva la terminal adentro. */
function terminalOf(c: any, cfg: any): string {
  const raw = String(c?.req?.header?.('x-terminal') ?? '').replace(/\D/g, '');
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 99999) return String(n);
  return String(cfg?.terminal ?? '1');
}

/** company_id de Alanube del tenant según el ambiente. Necesario para consultar
 *  documentos de empresas 'associated' (?idCompany=). */
function feCompanyId(cfg: any): string | undefined {
  const isSandbox = String(cfg?.environment ?? 'production') === 'sandbox';
  return (isSandbox ? cfg?.alanube_company_id_sandbox : cfg?.alanube_company_id_production) ?? cfg?.alanube_company_id ?? undefined;
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
 *  también la clave real de Hacienda (50 díg) y el estado CRUDO (para depurar).
 *  Exportada para reusarla desde la pasarela de FE externa (feExternal.ts). */
export async function alanubeDocStatus(client: ReturnType<typeof alanube.forEnv>, docId: string, opts?: { kind?: 'invoice' | 'ticket' | 'credit-note' | 'debit-note'; companyId?: string }): Promise<{ status: string; rawStatus: any; clave: string | null; error: string | null; raw: any }> {
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

// Consulta el estatus de UNA factura en Hacienda y lo GUARDA. Reutilizable desde
// la ruta del tenant y desde el panel admin (reintento por fila en la bitácora).
export async function refreshInvoiceStatus(tenantId: string, invoiceId: string): Promise<{ fe_status: string; ind_estado: any; error: any }> {
  const cfg = await loadFEConfig(tenantId);
  const provider = cfg.fe_provider === 'alanube' ? 'alanube' : 'facturemos';
  if (provider === 'facturemos' && !cfg.api_key_emisor) throw new Error('Falta configurar la ApiKey del emisor');
  const env = cfg.environment === 'sandbox' ? 'sandbox' : 'production'; // default producción

  const { data: inv } = await db.from('invoices')
    .select('id, invoice_number, fe_clave, fe_consecutivo, document_type').eq('id', invoiceId).eq('tenant_id', tenantId).maybeSingle();
  if (!(inv as any)?.fe_clave) throw new Error('La factura no fue emitida');

  let fe_status = 'sent';
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  let indEstado: any = null, errDetail: any = null;
  if (provider === 'alanube') {
    const docId = (inv as any).fe_consecutivo;
    if (!docId) throw new Error('No hay id de documento de Alanube para consultar. Volvé a emitir.');
    const r = await alanubeDocStatus(alanube.forTenant(cfg), docId, { kind: feKindOf((inv as any).document_type), companyId: feCompanyId(cfg) });
    fe_status = r.status; indEstado = r.rawStatus; errDetail = r.error;
    patch.fe_status = fe_status;
    patch.fe_error = r.error;
    patch.fe_response = r.raw;
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
  let upd = await db.from('invoices').update(patch).eq('id', invoiceId).eq('tenant_id', tenantId);
  if (upd.error && /fe_response|fe_request/.test(upd.error.message)) {
    const { fe_response, fe_request, ...rest } = patch;   // migración 55 sin correr
    upd = await db.from('invoices').update(rest).eq('id', invoiceId).eq('tenant_id', tenantId);
  }
  if (fe_status === 'accepted') autoSendComprobanteToCustomer(tenantId, invoiceId);
  let consecutivo_bumped: number | null = null;
  if (fe_status === 'rejected' || fe_status === 'error') {
    const docLabel = `#${(inv as any)?.invoice_number ?? invoiceId}`;
    // Mensaje LEGIBLE (no el texto crudo con códigos y comillas dobles de Hacienda).
    void notifyFeError(tenantId, docLabel,
      cleanHaciendaError(errDetail) || 'Comprobante rechazado por Hacienda').catch(() => {});
    // Rechazo por consecutivo ya usado (-99): subir el piso para que el próximo no choque.
    consecutivo_bumped = await bumpConsecutivoOnDuplicate(
      tenantId, cfg, (inv as any)?.document_type, errDetail ?? patch.fe_error);
  }
  return { fe_status, ind_estado: indEstado, error: errDetail, consecutivo_bumped } as any;
}

/** Estado de una NOTA de crédito/débito. Es un documento PROPIO ante Hacienda:
 *  se consulta por SU clave (Facturemos) y se guarda en fe_nc_status/fe_nd_status.
 *  Con Alanube el estado llega por webhook: no guardamos el id del documento de la
 *  nota, así que se informa en vez de fallar. */
export async function refreshNoteStatus(
  tenantId: string, invoiceId: string, kind: 'nc' | 'nd',
): Promise<{ fe_status: string; ind_estado: any; error: any; note: string | null }> {
  const cfg = await loadFEConfig(tenantId);
  const provider = cfg.fe_provider === 'alanube' ? 'alanube' : 'facturemos';
  const claveCol  = kind === 'nc' ? 'fe_nc_clave'  : 'fe_nd_clave';
  const statusCol = kind === 'nc' ? 'fe_nc_status' : 'fe_nd_status';

  const { data: inv } = await db.from('invoices')
    .select(`id, ${claveCol}, ${statusCol}`).eq('id', invoiceId).eq('tenant_id', tenantId).maybeSingle();
  const clave = String((inv as any)?.[claveCol] ?? '').replace(/\D/g, '');
  const label = kind === 'nc' ? 'nota de crédito' : 'nota de débito';
  if (!clave) throw new Error(`Esta factura no tiene ${label} emitida.`);

  if (provider !== 'facturemos') {
    // Alanube: se consulta con el id del documento (ULID). Se prueban, en orden:
    // el id guardado al emitir, y si no hay, lo que esté en la columna de clave
    // (cuando Alanube no devolvió la clave, ahí quedó el propio id).
    const docCol = kind === 'nc' ? 'fe_nc_doc_id' : 'fe_nd_doc_id';
    let storedId: string | null = null;
    try {
      const { data: r2 } = await db.from('invoices').select(docCol).eq('id', invoiceId).maybeSingle();
      storedId = (r2 as any)?.[docCol] ?? null;
    } catch { /* migración 75 sin correr */ }
    const rawClave = String((inv as any)?.[claveCol] ?? '');
    const candidates = [storedId, /^\d{50}$/.test(rawClave) ? null : rawClave].filter(Boolean) as string[];

    if (candidates.length === 0) {
      return {
        fe_status: String((inv as any)?.[statusCol] ?? 'sent'),
        ind_estado: null, error: null,
        note: `No se guardó el id de documento de esta ${label} (se emitió antes de la migración 75), `
          + `así que no se puede reconsultar en Alanube. Su estado se actualiza cuando llega el webhook. `
          + `Si quedó trabada, verificá la clave ${rawClave} directamente en Hacienda (ATV).`,
      };
    }

    const client = alanube.forTenant(cfg);
    let last: any = null;
    for (const docId of candidates) {
      try {
        const r = await alanubeDocStatus(client, docId, { kind: 'credit-note', companyId: feCompanyId(cfg) });
        await db.from('invoices').update({ [statusCol]: r.status, updated_at: new Date().toISOString() })
          .eq('id', invoiceId).eq('tenant_id', tenantId);
        return { fe_status: r.status, ind_estado: r.rawStatus, error: r.error, note: null };
      } catch (e: any) { last = e; }
    }
    return {
      fe_status: String((inv as any)?.[statusCol] ?? 'sent'),
      ind_estado: null, error: last?.message ?? null,
      note: `Alanube no devolvió el estado de esta ${label}: ${last?.message ?? 'documento no encontrado'}. `
        + 'Se actualizará cuando llegue el webhook.',
    };
  }

  if (!cfg.api_key_emisor) throw new Error('Falta configurar la ApiKey del emisor');
  const env = cfg.environment === 'sandbox' ? 'sandbox' : 'production';
  const data = await consultaEstatus(env, cfg.api_key_emisor, clave);
  const fe_status = mapEstado(data?.Ind_estado);
  await db.from('invoices').update({ [statusCol]: fe_status, updated_at: new Date().toISOString() })
    .eq('id', invoiceId).eq('tenant_id', tenantId);
  return { fe_status, ind_estado: data?.Ind_estado ?? null, error: data?.Error ?? null, note: null };
}

// POST /refresh-status — consulta el estatus de una factura por su Clave y lo GUARDA.
hacienda.post('/refresh-status', async (c) => {
  try {
    const { invoice_id } = await c.req.json().catch(() => ({}));
    if (!invoice_id) return fail(c, 'Falta invoice_id', 422);
    return ok(c, await refreshInvoiceStatus(c.get('tenantId'), invoice_id));
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
          const r = await alanubeDocStatus(alanube.forTenant(cfg), inv.fe_consecutivo, { kind, companyId: feCompanyId(cfg) });
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
// Núcleo de emisión de UNA factura ya creada. Reutilizado por el POS (/emit) y por
// la re-emisión desde el panel admin. `opts.renumber` reasigna el consecutivo
// respetando el piso configurado en Datos de FE y limpia el estado FE previo (para
// re-enviar una factura que salió con el consecutivo equivocado).
export async function emitInvoiceCore(
  c: any,
  tenantId: string,
  invoice_id: string | undefined,
  opts: {
    debug?: boolean; renumber?: boolean;
    /** Consecutivo de Hacienda EXACTO a usar (re-emisión desde el panel admin).
     *  Sin esto solo se puede tomar «el siguiente», que es justo el que Hacienda
     *  ya rechazó cuando el contador quedó atrasado. */
    consecutivo?: number;
  } = {},
): Promise<Response> {
  const debug = opts.debug === true;
  try {
    if (!invoice_id) return fail(c, 'Falta invoice_id', 422);

    const cfg = await loadFEConfig(tenantId);
    if (!cfg.enabled) return fail(c, 'La facturación electrónica no está activada', 409);
    const provider = cfg.fe_provider === 'alanube' ? 'alanube' : 'facturemos';
    if (provider === 'facturemos' && !cfg.api_key_emisor) return fail(c, 'Falta configurar la ApiKey del emisor', 422);
    // Se acepta el id del AMBIENTE activo (o el legacy). Con empresas asociadas el
    // id es obligatorio: es lo que le dice a Alanube con cuál emisor firmar.
    if (provider === 'alanube' && !feCompanyId(cfg)) return fail(c, 'La empresa no está dada de alta en Alanube. Usá «Crear empresa en Alanube».', 422);
    const env = cfg.environment === 'sandbox' ? 'sandbox' : 'production'; // default producción

    // Factura + ítems.
    const { data: inv } = await db.from('invoices')
      .select('*, invoice_items(*)').eq('id', invoice_id).eq('tenant_id', tenantId).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    if ((inv as any).fe_clave && !opts.renumber) return fail(c, 'La factura ya fue emitida', 409);

    // Re-emisión (admin): asigna el SIGUIENTE consecutivo disponible (respetando el
    // piso configurado en Datos de FE) y limpia el estado FE previo, para volver a
    // enviar la MISMA factura. Se toma un número nuevo SIEMPRE que la factura ya
    // haya sido transmitida (tiene clave, aunque haya sido rechazada): en Hacienda
    // un consecutivo ya enviado queda "quemado" y no se puede reutilizar.
    if (opts.renumber) {
      const floor = configuredNextConsecutivo(cfg, (inv as any).document_type);
      const clearFE = {
        fe_clave: null, fe_consecutivo: null, fe_status: null, fe_situacion: null,
        fe_error: null, fe_request: null, fe_response: null, fe_environment: null,
      };
      // nextInvoiceNumber incluye la factura actual en el máximo, así que devuelve
      // el siguiente número: si salió con 1 → sube al piso (643); si salió con 670
      // (rechazada) → 671.
      let newNum = await nextInvoiceNumber(tenantId, 0, floor);
      for (let attempt = 0; attempt < 8; attempt++) {
        const { error } = await db.from('invoices').update({ ...clearFE, invoice_number: newNum })
          .eq('id', invoice_id).eq('tenant_id', tenantId);
        if (!error) { (inv as any).invoice_number = newNum; break; }
        if (!(String((error as any)?.code) === '23505' || /duplicate/i.test((error as any)?.message ?? ''))) break;
        newNum = await nextInvoiceNumber(tenantId, attempt + 1, floor);
      }
      (inv as any).fe_clave = null;
    }

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
        // Ad-hoc (sin producto en catálogo): usa el nombre guardado en el ítem.
        product_name: p.name ?? it.product_name ?? 'Producto',
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
      // Aviso al dueño por WhatsApp (fire-and-forget, no bloquea la respuesta).
      const docLabel = `#${(inv as any)?.invoice_number ?? invoice_id}`;
      void notifyFeError(tenantId, docLabel, msg).catch(() => {});
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

    // Consecutivo de Hacienda: el siguiente de la serie, salvo que el admin haya
    // pedido uno concreto al re-emitir (porque el contador quedó atrasado y
    // Hacienda rechazó el que tocaba). Se resuelve acá para que los dos
    // proveedores usen exactamente el mismo criterio.
    const forcedConsec = Number(opts.consecutivo) > 0 ? Math.floor(Number(opts.consecutivo)) : 0;
    const takeConsecutivo = (sucursal: string, terminal: string): Promise<string> =>
      forcedConsec
        ? forceConsecutivo(tenantId, tipoDoc, forcedConsec, sucursal, terminal)
        : reserveConsecutivo(
            tenantId, tipoDoc, configuredNextConsecutivo(cfg, (inv as any).document_type),
            sucursal, terminal);

    // ── Proveedor ALANUBE ─────────────────────────────────────────────────────
    if (provider === 'alanube') {
      const kind = tipoDoc === '01' ? 'invoice' : 'ticket';
      // Consecutivo PROPIO del tipo. Antes iba el número interno de la factura,
      // así que factura y tiquete compartían secuencia y las notas heredaban el
      // número del documento que corrigen.
      const doc = buildAlanubeDocument(emisor, inv as any, lines, receptor, {
        tipoDoc,
        headquarters: cfg.sucursal, terminal: terminalOf(c, cfg),
        numberOfDocument: await takeConsecutivo(String(cfg.sucursal ?? '1'), terminalOf(c, cfg)),
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
        resp = await alanube.forTenant(cfg).emitDocument(kind as any, doc, feCompanyId(cfg), { asCompany: cfg.alanube_company_type === 'associated' });
      } catch (e: any) {
        // Guardar el JSON enviado para poder verlo en la bitácora aunque falle.
        await db.from('invoices').update({ fe_request: doc }).eq('id', invoice_id).eq('tenant_id', tenantId).then(() => {}, () => {});
        return await failFE(e instanceof AlanubeError ? friendlyAlanubeError(e.message) : (e?.message ?? 'Error emitiendo con Alanube'));
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

      void maybeNotifyQuotaLow(tenantId);
      return ok(c, { ok: true, provider: 'alanube', clave, alanube_doc_id: docId, alanube_status: alanubeStatus, tipo: tipoDoc, response: resp });
    }

    // ── Proveedor FACTUREMOS (flujo existente) ────────────────────────────────
    // Cada tipo lleva su propia numeración: se reserva acá, no se hereda del
    // número interno de la factura.
    const sucursalFe = String(cfg.sucursal ?? '1');
    const terminalFe = terminalOf(c, cfg);
    const consecutivo = buildConsecutivo(inv as any, {
      sucursal: sucursalFe, terminal: terminalFe, situacion: '1', tipoComprobante: tipoDoc,
      consecutivoInterno: await takeConsecutivo(sucursalFe, terminalFe),
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

    void maybeNotifyQuotaLow(tenantId);
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
}

hacienda.post('/emit', async (c) => {
  const tenantId = c.get('tenantId');
  const body = await c.req.json().catch(() => ({} as any));
  return emitInvoiceCore(c, tenantId, body?.invoice_id, { debug: body?.debug === true });
});

// POST /credit-note — emite una Nota de Crédito (03) que ANULA una factura ya
// emitida. body: { invoice_id, reason? }.
hacienda.post('/credit-note', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  return emitCreditNoteCore(c, c.get('tenantId'), body?.invoice_id, body?.reason);
});

/** Emite la Nota de Crédito de anulación de una factura. Extraída de la ruta para
 *  poder reusarla desde el panel admin (anulación en lote). */
export async function emitCreditNoteCore(
  c: any, tenantId: string, invoiceId: string | undefined, reason?: string,
  opts?: { companyIdOverride?: string | null },
): Promise<Response> {
  const invoice_id = invoiceId;
  // Id de empresa de Alanube a usar para ESTA nota. Sirve cuando la empresa se
  // volvió a crear (id nuevo) y la config todavía tiene el anterior.
  const companyOverride = String(opts?.companyIdOverride ?? '').trim() || null;
  {
  try {
    if (!invoice_id) return fail(c, 'Falta invoice_id', 422);

    const cfg = await loadFEConfig(tenantId);
    const provider = cfg.fe_provider === 'alanube' ? 'alanube' : 'facturemos';
    if (provider === 'facturemos' && !cfg.api_key_emisor) return fail(c, 'Falta configurar la ApiKey del emisor', 422);
    const alanubeCompanyId = companyOverride ?? (String(cfg.environment ?? 'production') === 'sandbox'
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
        headquarters: cfg.sucursal, terminal: terminalOf(c, cfg),
        // Serie propia de notas de crédito: dos notas sobre la misma factura ya
        // no salen con el mismo consecutivo (rechazo -99).
        numberOfDocument: await reserveConsecutivo(
          tenantId, '03', configuredNextConsecutivo(cfg, 'nota_credito'),
          String(cfg.sucursal ?? '1'), terminalOf(c, cfg)),
        // Empresa emisora en Alanube según el ambiente (para que emita el tenant y
        // no la 'main' de la cuenta). Sin id, Alanube usa la main por defecto.
        senderId: companyOverride ?? (String(cfg.environment ?? 'production') === 'sandbox'
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
        resp = await alanube.forTenant(cfg).emitDocument('credit-note', doc, companyOverride ?? feCompanyId(cfg), { asCompany: cfg.alanube_company_type === 'associated' });
      } catch (e: any) {
        return fail(c, e instanceof AlanubeError ? friendlyAlanubeError(e.message) : (e?.message ?? 'Error emitiendo NC con Alanube'), 422);
      }
      const docObj = resp?.creditNote ?? resp?.document ?? resp?.data ?? resp;
      const ncId = docObj?.id ?? deepFind(resp, /(^id$|_id$|documentId$)/i, 10) ?? null;
      const ncClave = docObj?.key ?? docObj?.clave ?? deepFind(resp, /(clave|^key$)/i, 40) ?? null;
      // Se guarda TAMBIÉN el id de Alanube: es lo único con lo que se puede
      // reconsultar el estado si el webhook se pierde.
      let updNc = await db.from('invoices').update({
        fe_nc_clave: ncClave ?? ncId, fe_nc_doc_id: ncId, fe_nc_status: 'sent',
        updated_at: new Date().toISOString(),
      }).eq('id', invoice_id).eq('tenant_id', tenantId);
      if (updNc.error && /fe_nc_doc_id/.test(updNc.error.message)) {   // migración 75 sin correr
        await db.from('invoices').update({
          fe_nc_clave: ncClave ?? ncId, fe_nc_status: 'sent',
          updated_at: new Date().toISOString(),
        }).eq('id', invoice_id).eq('tenant_id', tenantId);
      }
      return ok(c, { ok: true, provider: 'alanube', nc_clave: ncClave, alanube_doc_id: ncId, response: resp });
    }

    // Consecutivo de NC (TipoComprobante 03) y referencia al documento original.
    // El número es PROPIO de la serie de notas de crédito. Antes se usaba el de
    // la factura original: dos notas sobre la misma factura salían con el mismo
    // consecutivo y Hacienda las rechazaba con -99.
    const sucursalNc = String(cfg.sucursal ?? '1');
    const terminalNc = terminalOf(c, cfg);
    const consecutivo = buildConsecutivo(inv as any, {
      sucursal: sucursalNc, terminal: terminalNc, situacion: '1', tipoComprobante: '03',
      consecutivoInterno: await reserveConsecutivo(
        tenantId, '03', configuredNextConsecutivo(cfg, 'nota_credito'), sucursalNc, terminalNc),
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
  }
}

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
        headquarters: cfg.sucursal, terminal: terminalOf(c, cfg),
        // Serie propia de notas de débito (ver el comentario de la NC).
        numberOfDocument: await reserveConsecutivo(
          tenantId, '02', configuredNextConsecutivo(cfg, 'nota_debito'),
          String(cfg.sucursal ?? '1'), terminalOf(c, cfg)),
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
        resp = await alanube.forTenant(cfg).emitDocument('debit-note', doc, feCompanyId(cfg), { asCompany: cfg.alanube_company_type === 'associated' });
      } catch (e: any) {
        return fail(c, e instanceof AlanubeError ? friendlyAlanubeError(e.message) : (e?.message ?? 'Error emitiendo ND con Alanube'), 422);
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
    // Serie propia de notas de débito (ver el comentario de la NC).
    const sucursalNd = String(cfg.sucursal ?? '1');
    const terminalNd = terminalOf(c, cfg);
    const consecutivo = buildConsecutivo(inv as any, {
      sucursal: sucursalNd, terminal: terminalNd, situacion: '1', tipoComprobante: '02',
      consecutivoInterno: await reserveConsecutivo(
        tenantId, '02', configuredNextConsecutivo(cfg, 'nota_debito'), sucursalNd, terminalNd),
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
    const base = 'id, invoice_number, customer_name, total, issued_at, created_at, document_type, payment_method, status, fe_clave, fe_consecutivo, fe_status, fe_error, fe_emailed';
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
        detail: cleanReceptionDetail(l.detail ?? l.Detalle),
        quantity: Number(l.quantity ?? l.Cantidad ?? 1),
        unit: l.unit ?? null,
        unit_price: Number(l.unit_price ?? l.PrecioUnitario ?? 0),
        // NETO (con descuento): SubTotal antes que total/MontoTotal (bruto).
        total: Number(l.subtotal ?? l.SubTotal ?? l.total ?? l.MontoTotal ?? 0),
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
        const resp = await alanube.forTenant(cfg).sendReceiverMessage(payload, String(senderCompanyId));
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

// POST /received/classify-all — marca de una vez TODOS los comprobantes que
// quedaron sin categorizar.
//
// La mayoría de los negocios no lleva órdenes de compra: para ellos cada factura
// de proveedor es simplemente «una compra», y clasificarlas de a una era trabajo
// puro sin ningún beneficio. Esto solo escribe la etiqueta: NO crea órdenes de
// compra, NO toca inventario y NO confirma nada ante Hacienda —esa aceptación es
// un acto legal y se sigue haciendo comprobante por comprobante, a propósito.
// body: { kind?: 'compra' | 'gasto' }
hacienda.post('/received/classify-all', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({} as any));
    const kind = body?.kind === 'gasto' ? 'gasto' : 'compra';

    const { data: pending, error: selErr } = await db.from('received_documents')
      .select('id').eq('tenant_id', tenantId).is('kind', null);
    if (selErr) throw new Error(selErr.message);

    const ids = (pending ?? []).map((r: any) => r.id);
    if (ids.length === 0) return ok(c, { updated: 0, kind });

    const { error } = await db.from('received_documents')
      .update({ kind, updated_at: new Date().toISOString() })
      .in('id', ids).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);

    return ok(c, { updated: ids.length, kind });
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
    const { id, purchase_id, items, no_inventory, no_products } = body as {
      id: string; purchase_id?: string; no_inventory?: boolean;
      items?: Array<{
        detail: string; quantity: number; unit_price: number; total?: number; subtotal?: number;
        cabys?: string | null; product_id?: string | null;
        action: 'update' | 'create' | 'skip'; no_stock?: boolean;
        /** Precio de VENTA (costo × margen) calculado en la pantalla. */
        sale_price?: number;
        /** Segundo código del producto. null/vacío = no tocarlo. */
        sku2?: string | null;
        /** Escribir `sale_price` en el producto. */
        reprice?: boolean;
      }>;
      /** true = la compra NO genera productos de catálogo (insumos de proceso), pero
       *  su MONTO sí se registra en la orden. Sin esto el total quedaba en ₡0. */
      no_products?: boolean;
    };
    if (!id) return fail(c, 'Falta el id', 422);

    // ── Conciliación POR LOTES ────────────────────────────────────────────
    // Cada línea del XML es una consulta a la base. Un comprobante de 250
    // artículos son cientos de idas y vueltas encadenadas: la petición se pasa
    // del tiempo máximo y el proxy la corta, dejando productos creados pero SIN
    // orden de compra. Por eso el front puede partir el trabajo:
    //
    //   stage:'products' → procesa un lote de líneas y devuelve las resueltas.
    //                      No toca la orden ni el comprobante.
    //   stage:'finish'   → recibe TODAS las líneas ya resueltas y arma la orden.
    //
    // El estado lo lleva el cliente entre llamada y llamada, así que el servidor
    // no guarda nada a medias: si un lote falla, no hay orden que limpiar.
    // Sin `stage` se comporta como siempre (todo en una sola llamada).
    const stage = (body.stage ?? 'all') as 'all' | 'products' | 'finish';

    const { data: doc } = await db.from('received_documents')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!doc) return fail(c, 'Comprobante no encontrado', 404);
    const d = doc as any;

    // Si el front no mandó items (o vinieron vacíos), los re-derivamos del XML.
    // Esto arregla el "0 artículos" cuando la bandeja no tenía las líneas.
    // En `finish` no aplica: ahí las líneas ya vienen resueltas de los lotes
    // anteriores y re-derivarlas duplicaría la orden.
    let workItems = Array.isArray(items) ? items : [];
    if (workItems.length === 0 && stage !== 'finish') {
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
      const det = cleanReceptionDetail(l.detail ?? l.Detalle).toLowerCase();
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
    // En `finish` las líneas ya vienen resueltas por los lotes previos; en los
    // demás modos se llenan abajo, recorriendo el XML.
    const purchaseItems: any[] = stage === 'finish' ? (body.lines ?? []) : [];

    // Monto de las líneas que NO generan producto (modo "no crear productos" o
    // líneas marcadas "No agregar"). Se registra igual en la orden: la plata se
    // gastó aunque el artículo no entre al catálogo.
    let skippedTotal = stage === 'finish' ? Number(body.skipped_total) || 0 : 0;

    for (const it of workItems) {
      if (it.action === 'skip') {
        const q = Number(it.quantity) || 1;
        skippedTotal += Number(it.total ?? it.subtotal) || q * (Number(it.unit_price) || 0);
        continue;
      }
      let productId = it.product_id ?? null;
      const qty = Number(it.quantity) || 1;
      // Costo por unidad CONFIABLE: el XML a veces trae un PrecioUnitario que NO
      // cuadra con el total de la línea (ej. 32100.98 vs 24396.74/24=1016.53) o con
      // hasta 19 decimales. Si el PrecioUnitario no cuadra con total÷cantidad, usamos
      // total÷cantidad; y siempre redondeamos a 2 decimales.
      const rawUnit = Number(it.unit_price) || 0;
      const lineTotal = Number(it.total ?? it.subtotal) || 0;
      const fromTotal = lineTotal > 0 && qty > 0 ? lineTotal / qty : rawUnit;
      const consistent = rawUnit > 0 && lineTotal > 0 && Math.abs(rawUnit * qty - lineTotal) <= Math.max(1, lineTotal * 0.02);
      const price = Math.round((consistent ? rawUnit : fromTotal) * 100) / 100;

      // Precio de VENTA. Llega calculado desde la pantalla (costo × margen, ya
      // redondeado) para que sea exactamente el que el usuario vio en la columna
      // «P. Venta». Si no viene, se cae al costo: es el comportamiento anterior.
      const sale = Number(it.sale_price) > 0 ? Number(it.sale_price) : price;
      const sku2 = String(it.sku2 ?? '').trim();

      if (it.action === 'update' && productId) {
        // Producto que COINCIDE (por código/nombre): actualizar CABYS/precio/nombre.
        const upd: any = { updated_at: new Date().toISOString() };
        if (it.cabys) upd.cabys_code = it.cabys;
        if (price > 0) upd.cost_price = price;
        if (supplierId) upd.supplier_id = supplierId;   // proveedor del comprobante
        // El precio de VENTA solo se toca si se pidió: una compra no debería
        // reescribir por su cuenta los precios del catálogo.
        if (it.reprice && sale > 0) upd.unit_price = sale;
        if (sku2) upd.sku2 = sku2;
        // Sobrescribir el NOMBRE con el del comprobante (limpio) si viene uno nuevo.
        const newName = cleanReceptionDetail(it.detail);
        if (newName) upd.name = newName;
        let uRes = await db.from('products').update(upd).eq('id', productId).eq('tenant_id', tenantId);
        // Un 2° código repetido no debe costar el resto de la línea: se reintenta
        // sin él y se avisa, para que el costo y el CABYS sí queden guardados.
        if (uRes.error && sku2 && /sku2|duplicate|unique/i.test(uRes.error.message)) {
          const { sku2: _drop, ...rest } = upd;
          uRes = await db.from('products').update(rest).eq('id', productId).eq('tenant_id', tenantId);
          if (!uRes.error) messages.push(`⚠️ El 2° código "${sku2}" ya lo tiene otro producto: no se guardó.`);
        }
        if (uRes.error) { messages.push(`⚠️ No se pudo actualizar "${it.detail}": ${uRes.error.message}`); }
        else { updated++; messages.push(`✏️ Actualizado (nombre/CABYS/precio): ${newName || it.detail}`); }
      } else {
        // Producto NUEVO (el código NO coincide con ninguno interno): se CREA ahora
        // y se agrega a la orden de una vez (antes se difería y la orden quedaba vacía).
        // SKU = código comercial del XML si viene; si no, autogenerado.
        const xmlCode = codeByDetail.get(cleanReceptionDetail(it.detail).toLowerCase()) || '';
        const baseProd = {
          tenant_id: tenantId,
          name: cleanReceptionDetail(it.detail) || 'Producto',
          cabys_code: it.cabys || null,
          // Costo del comprobante y precio de venta con el margen de la pantalla.
          // Antes los dos eran el costo: el producto entraba con margen CERO y
          // había que corregirlo a mano después de cada compra.
          cost_price: price, unit_price: sale,
          ...(sku2 ? { sku2 } : {}),
          // tracks_stock por LÍNEA: `no_stock` gana sobre el interruptor global, así
          // se puede crear un insumo infinito y otro con inventario en la misma compra.
          stock_quantity: 0, tracks_stock: !(it.no_stock ?? noInventory),
          supplier_id: supplierId,   // proveedor del comprobante
        };
        let ins = await db.from('products').insert({ ...baseProd, sku: xmlCode || genReceptionSku(it.detail) }).select('id').single();
        // Si el código del XML choca con un SKU ya existente, reintenta con uno único.
        if (ins.error && xmlCode && /duplicate|unique|sku/i.test(ins.error.message)) {
          ins = await db.from('products').insert({ ...baseProd, sku: genReceptionSku(it.detail) }).select('id').single();
        }
        // Último recurso: si lo que choca es el 2° código, se crea sin él. Vale
        // más el producto en el catálogo que el código de barras.
        if (ins.error && sku2 && /sku2|duplicate|unique/i.test(ins.error.message)) {
          const { sku2: _drop, ...rest } = baseProd as any;
          ins = await db.from('products').insert({ ...rest, sku: genReceptionSku(it.detail) }).select('id').single();
          if (!ins.error) messages.push(`⚠️ El 2° código "${sku2}" ya lo tiene otro producto: no se guardó.`);
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

    // Fin del lote: se devuelven las líneas resueltas para que el front las
    // acumule. La orden se arma en la última llamada (`finish`), cuando ya están
    // TODAS: crearla acá dejaría una orden por lote.
    if (stage === 'products') {
      return ok(c, {
        ok: true, stage: 'products',
        lines: purchaseItems, skipped_total: skippedTotal,
        created, updated, messages,
      });
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
      const addTotal = purchaseItems.reduce((s, pi) => s + pi.subtotal, 0) + skippedTotal;
      await db.from('purchases').update({
        total_amount: isReload ? addTotal : Number((existing as any)?.total_amount ?? 0) + addTotal,
        updated_at: new Date().toISOString(),
      }).eq('id', purchaseId).eq('tenant_id', tenantId);
      messages.push(isReload
        ? `🔄 Orden ${purchaseNumber} recargada con ${purchaseItems.length} artículo(s).`
        : `🔗 ${purchaseItems.length} artículo(s) agregado(s) a la orden ${purchaseNumber}.`);
    } else {
      const total = (purchaseItems.reduce((s, pi) => s + pi.subtotal, 0) + skippedTotal) || Number(d.total ?? 0);
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

    // Resumen para el total a registrar. En `finish` los conteos los trae el
    // front sumando los lotes: acá ya no se procesó ningún producto.
    const totalReg = purchaseItems.reduce((s, pi) => s + pi.subtotal, 0) + skippedTotal;
    const totCreated = stage === 'finish' ? (Number(body.created) || 0) : created;
    const totUpdated = stage === 'finish' ? (Number(body.updated) || 0) : updated;
    messages.unshift(`💰 Total registrado ₡${totalReg.toLocaleString('es-CR')} · ${totUpdated} coincidencia(s) con CABYS/precio actualizado · ${totCreated} producto(s) nuevo(s) creado(s).`);
    if (skippedTotal > 0) {
      messages.push(no_products
        ? `📦 ₡${skippedTotal.toLocaleString('es-CR')} registrado SIN crear productos (insumos de proceso): el monto entra en la orden pero no se detalla por artículo.`
        : `📦 ₡${skippedTotal.toLocaleString('es-CR')} de líneas marcadas "No agregar": el monto se registró, sin crear el producto.`);
    }

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

    return ok(c, { ok: true, purchase_id: purchaseId, purchase_number: purchaseNumber, updated: totUpdated, created: totCreated, items: purchaseItems.length, total: totalReg, messages }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /received/credit-note — acepta una NOTA DE CRÉDITO del proveedor.
//
// Una NC no ingresa mercadería: o devuelve plata (descuento posterior) o devuelve
// PRODUCTO. En el segundo caso el stock que entró con la factura original tiene
// que salir, porque físicamente ya no está.
//
// `restock: false` es para la NC que es solo descuento —el precio bajó, la
// mercadería se quedó—: ahí restar existencias inventaría un faltante que no
// existe. Por eso se pregunta en vez de asumir.
//
// body: { id, restock?: boolean }
hacienda.post('/received/credit-note', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({} as any));
    const id = String(body?.id ?? '');
    const restock = body?.restock !== false;   // por defecto sí devuelve producto
    if (!id) return fail(c, 'Falta el id', 422);

    const { data: doc } = await db.from('received_documents')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!doc) return fail(c, 'Comprobante no encontrado', 404);
    const d = doc as any;

    const tipo = String(d.document_type ?? '') || String(d.clave ?? '').slice(29, 31);
    if (tipo !== '03') {
      return fail(c, 'Este comprobante no es una nota de crédito.', 409);
    }

    const messages: string[] = [];
    const applied: any[] = [];

    if (restock) {
      // Se emparejan las líneas igual que en una compra: por CABYS, código o
      // nombre. Lo que no calce se informa en vez de inventarse un producto —
      // crear catálogo desde una devolución no tiene ningún sentido.
      const matched = await matchLines(tenantId, linesFromDoc(d));
      for (const m of matched as any[]) {
        const qty = Number(m.quantity) || 0;
        if (!m.product_id || qty <= 0) {
          if (qty > 0) messages.push(`⚠️ Sin producto que coincida: "${m.detail}" (${qty})`);
          continue;
        }
        const { data: p } = await db.from('products')
          .select('stock_quantity, tracks_stock, name, cost_price')
          .eq('id', m.product_id).eq('tenant_id', tenantId).maybeSingle();
        if (!p) continue;
        if ((p as any).tracks_stock === false) {
          messages.push(`∞ ${(p as any).name}: sin control de stock, no se descuenta.`);
          continue;
        }
        const before = Number((p as any).stock_quantity ?? 0);
        const after = before - qty;

        // La bitácora primero: si no se puede registrar el porqué, no se mueve
        // el inventario. Un faltante sin motivo aparece después como varianza.
        const { error: aErr } = await db.from('stock_adjustments').insert({
          tenant_id: tenantId, product_id: m.product_id, user_id: userId ?? null,
          type: 'return', quantity: -qty, stock_before: before, stock_after: after,
          reason: 'Nota de crédito de proveedor',
          notes: `${d.issuer_name ?? ''} · Clave ${d.clave ?? ''}`.trim(),
        });
        if (aErr) { messages.push(`⚠️ No se pudo registrar ${(p as any).name}: ${aErr.message}`); continue; }

        await db.from('products')
          .update({ stock_quantity: after, updated_at: new Date().toISOString() })
          .eq('id', m.product_id).eq('tenant_id', tenantId);
        applied.push({ product_id: m.product_id, name: (p as any).name, quantity: qty });
      }
    }

    await db.from('received_documents')
      .update({ kind: 'compra', updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId);

    messages.unshift(restock
      ? `↩ Nota de crédito aceptada · ${applied.length} producto(s) devuelto(s) al proveedor.`
      : '↩ Nota de crédito aceptada como descuento: no se tocó el inventario.');
    messages.push(`💸 Resta ₡${Number(d.total ?? 0).toLocaleString('es-CR')} del crédito fiscal del período.`);

    return ok(c, { ok: true, restocked: applied.length, items: applied, messages });
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

/**
 * Baja de Alanube el XML firmado y el XML de respuesta de Hacienda.
 *
 * Dos detalles que hacían que llegara solo el PDF:
 *  · `idCompany` es OBLIGATORIO para las empresas 'associated'. Sin él, Alanube
 *    contesta "document not found" y el XML se perdía en silencio — el PDF sí
 *    llegaba porque su endpoint siempre lo mandaba.
 *  · el separador de `documents` no es el mismo en todas las cuentas, así que se
 *    prueban las dos formas antes de darse por vencido.
 */
export async function alanubeXmlFiles(
  cfg: any, docId: string, kind: any, companyId?: string | null,
): Promise<{ xml: string | null; xmlHacienda: string | null }> {
  const client = alanube.forTenant(cfg);
  for (const documents of ['xml,xmlHacienda', 'xml-xmlHacienda']) {
    try {
      const resp: any = await client.getDocument(String(docId), {
        kind, documents, companyId: companyId ? String(companyId) : undefined,
      });
      const d = resp?.invoice ?? resp?.ticket ?? resp?.creditNote ?? resp?.debitNote
        ?? resp?.document ?? resp?.data ?? resp;
      const xml = await toB64(d?.xml ?? deepFind(resp, /^xml$/i, 8_000_000));
      const xmlHacienda = await toB64(
        d?.xmlHacienda ?? d?.xmlResponse ?? deepFind(resp, /xml_?hacienda|xmlresponse/i, 8_000_000));
      if (xml || xmlHacienda) return { xml, xmlHacienda };
    } catch (e: any) { console.warn(`[FE xml] ${documents}:`, e?.message); }
  }
  return { xml: null, xmlHacienda: null };
}

async function alanubeAttachments(cfg: any, docId: string | null | undefined, kind: any, clave: string, companyId?: string | null): Promise<Array<{ filename: string; content: string }>> {
  const out: Array<{ filename: string; content: string }> = [];
  if (!docId) return out;
  const client = alanube.forTenant(cfg);
  const base = String(clave || docId);

  // 1) XML firmado + XML de respuesta de Hacienda. Son los que valen ante
  //    Hacienda: el PDF es solo la representación gráfica.
  const { xml, xmlHacienda } = await alanubeXmlFiles(cfg, String(docId), kind, companyId);
  if (xml) out.push({ filename: `${base}.xml`, content: xml });
  if (xmlHacienda) out.push({ filename: `${base}-respuesta-hacienda.xml`, content: xmlHacienda });

  // 2) PDF por el endpoint dedicado (base64). Requiere idCompany y el tipo de
  //    documento tal como lo nombra Alanube ('invoice', 'ticket', 'credit-note',
  //    'debit-note'). Un tipo mal escrito no da error: devuelve vacío, y el
  //    correo sale sin PDF sin que nada lo explique.
  if (!companyId) {
    console.warn(`[FE email] sin idCompany: no se puede pedir el PDF de ${base}`);
  } else {
    try {
      const r: any = await client.getDocumentPdf(String(docId), String(kind), String(companyId));
      const pdf = await toB64(r?.pdf ?? deepFind(r, /^pdf$/i, 12_000_000));
      if (pdf) out.push({ filename: `${base}.pdf`, content: pdf });
      else console.warn(`[FE email] Alanube no devolvió PDF de ${base} (tipo "${kind}", doc ${docId})`);
    } catch (e: any) {
      console.warn(`[FE email] PDF no disponible de ${base} (tipo "${kind}"):`, e?.message);
    }
  }

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
  // Adjuntos de Alanube. Si el XML no vino (o el proveedor no es Alanube), se
  // adjunta el `fe_xml` guardado: al cliente le sirve igual y es el que Hacienda
  // reconoce. Un correo con solo el PDF no es un comprobante entregado.
  const atts = [...(attachments ?? [])];
  const hasXml = atts.some(a => a.filename.toLowerCase().endsWith('.xml'));
  if (!hasXml && i.fe_xml) {
    atts.push({
      filename: `${i.fe_clave}.xml`,
      content: Buffer.from(String(i.fe_xml), 'utf8').toString('base64'),
    });
  }
  await sendEmail({ to, subject: `Comprobante electrónico ${i.invoice_number}`, html, attachments: atts.length ? atts : undefined });
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

// POST /resend-email — reenvía un comprobante por correo.
//
// body: { invoice_id, email, kind?: 'invoice' | 'nc' | 'nd' }
//
// `kind` decide QUÉ documento se manda. Antes siempre iba la factura, así que
// una nota de crédito no se podía reenviar nunca: el cliente que anulaba una
// compra se quedaba sin el comprobante que la respalda ante Hacienda, y desde la
// bitácora no había forma de mandárselo.
/**
 * Envía la NOTA al cliente cuando Hacienda la ACEPTA.
 *
 * La factura ya se enviaba sola al aceptarse; la nota de crédito no, así que el
 * cliente al que se le anulaba una compra nunca recibía el comprobante que la
 * respalda. Para él eso importa tanto como la factura: es lo que sustenta que ya
 * no debe ese IVA.
 *
 * La marca de «ya enviado» usa una columna propia si existe y, si no, se envía
 * igual: duplicar un correo es molesto, pero no mandarlo le deja al cliente un
 * hueco en su contabilidad.
 */
export async function autoSendNotaToCustomer(
  tenantId: string, invoiceId: string, kind: 'nc' | 'nd',
): Promise<void> {
  try {
    const claveCol = kind === 'nc' ? 'fe_nc_clave' : 'fe_nd_clave';
    const docCol   = kind === 'nc' ? 'fe_nc_doc_id' : 'fe_nd_doc_id';
    const sentCol  = kind === 'nc' ? 'fe_nc_emailed' : 'fe_nd_emailed';

    const { data: inv } = await db.from('invoices')
      .select(`invoice_number, total, customer_name, customer_id, document_type, ${claveCol}, ${docCol}`)
      .eq('id', invoiceId).eq('tenant_id', tenantId).maybeSingle();
    const i = inv as any;
    if (!i?.[claveCol]) return;

    // Si la columna de "ya enviado" existe y está marcada, no se repite.
    try {
      const { data: sent } = await db.from('invoices').select(sentCol).eq('id', invoiceId).maybeSingle();
      if ((sent as any)?.[sentCol]) return;
    } catch { /* la columna no existe: se envía igual */ }

    if (!i.customer_id) return;
    const { data: cust } = await db.from('customers').select('email').eq('id', i.customer_id).maybeSingle();
    const email = (cust as any)?.email ?? null;
    if (!email) return;   // sin correo del cliente no hay a dónde mandarlo

    const cfg = await loadFEConfig(tenantId);
    const label = kind === 'nc' ? 'Nota de crédito' : 'Nota de débito';
    const atts = cfg.fe_provider === 'alanube'
      ? await alanubeAttachments(cfg, i[docCol] ?? i[claveCol],
          (kind === 'nc' ? 'credit-note' : 'debit-note') as any, i[claveCol],
          (String(cfg.environment ?? 'production') === 'sandbox' ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id)
      : undefined;

    await sendComprobanteEmail(email, {
      ...i,
      fe_clave: i[claveCol],
      invoice_number: `${label} · ${i.invoice_number}`,
      fe_xml: null,   // el XML guardado es el de la factura, no el de la nota
    } as any, atts);

    await db.from('invoices').update({ [sentCol]: true })
      .eq('id', invoiceId).eq('tenant_id', tenantId).then(() => {}, () => {});
  } catch (e: any) {
    console.warn('[FE email nota] no se pudo enviar:', e?.message);
  }
}

hacienda.post('/resend-email', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { invoice_id, email, kind } = await c.req.json().catch(() => ({}));
    if (!invoice_id || !email) return fail(c, 'Falta invoice_id o email', 422);
    const which: 'invoice' | 'nc' | 'nd' =
      kind === 'nc' || kind === 'nd' ? kind : 'invoice';

    const { data: inv } = await db.from('invoices')
      .select('invoice_number, fe_clave, fe_consecutivo, fe_status, fe_xml, total, customer_name, document_type, '
        + 'fe_nc_clave, fe_nc_doc_id, fe_nd_clave, fe_nd_doc_id')
      .eq('id', invoice_id).eq('tenant_id', tenantId).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    const i = inv as any;

    // Documento a mandar: clave, id de Alanube y cómo llamarlo en el correo.
    const doc = which === 'nc'
      ? { clave: i.fe_nc_clave, docId: i.fe_nc_doc_id ?? i.fe_nc_clave, kind: 'credit-note', label: 'Nota de crédito' }
      : which === 'nd'
        ? { clave: i.fe_nd_clave, docId: i.fe_nd_doc_id ?? i.fe_nd_clave, kind: 'debit-note', label: 'Nota de débito' }
        : { clave: i.fe_clave, docId: i.fe_consecutivo, kind: feKindOf(i.document_type), label: null as string | null };

    if (!doc.clave) {
      return fail(c, which === 'invoice'
        ? 'La factura no fue emitida electrónicamente'
        : `Esta factura no tiene ${which === 'nc' ? 'nota de crédito' : 'nota de débito'} emitida.`, 422);
    }

    // Con Alanube, bajamos XML + respuesta de Hacienda + PDF para adjuntar.
    const cfg = await loadFEConfig(tenantId);
    const attachments = cfg.fe_provider === 'alanube'
      ? await alanubeAttachments(cfg, doc.docId, doc.kind as any, doc.clave,
          (String(cfg.environment ?? 'production') === 'sandbox' ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id)
      : undefined;

    // El correo se arma con la clave y el número del documento que se manda: si
    // fuera con los de la factura, el cliente recibiría una nota de crédito
    // rotulada como factura y no sabría qué guardar.
    await sendComprobanteEmail(email, {
      ...i,
      fe_clave: doc.clave,
      invoice_number: doc.label ? `${doc.label} · ${i.invoice_number}` : i.invoice_number,
      // El XML guardado es el de la FACTURA: no sirve para la nota.
      fe_xml: which === 'invoice' ? i.fe_xml : null,
    }, attachments);

    // Solo la factura marca `fe_emailed`: ese check de la bitácora significa
    // «el comprobante de venta ya se envió», y una nota no lo reemplaza.
    if (which === 'invoice') {
      await db.from('invoices').update({ fe_emailed: true }).eq('id', invoice_id).eq('tenant_id', tenantId).then(() => {}, () => {});
    }
    const hasPdf = (attachments ?? []).some(a => a.filename.toLowerCase().endsWith('.pdf'));
    return ok(c, {
      ok: true, kind: which, attachments: attachments?.length ?? 0, pdf: hasPdf,
      // Se avisa en vez de fallar: el correo con los XML ya es un comprobante
      // entregado, y el PDF es solo su representación gráfica.
      warning: hasPdf ? null : 'Se envió sin PDF: Alanube no lo devolvió para este documento.',
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /fe-xml/:id — XML firmado y respuesta de Hacienda, en base64, para
// descargarlos desde la bitácora. El XML es el comprobante de verdad: el
// contribuyente tiene que poder guardarlo, no solo ver el PDF.
hacienda.get('/fe-xml/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data: inv } = await db.from('invoices')
      .select('fe_consecutivo, fe_clave, fe_xml, document_type')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    const i = inv as any;
    const base = String(i.fe_clave || id);

    const cfg = await loadFEConfig(tenantId);
    let xml: string | null = null;
    let xmlHacienda: string | null = null;

    if (cfg.fe_provider === 'alanube' && i.fe_consecutivo) {
      const companyId = (String(cfg.environment ?? 'production') === 'sandbox'
        ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id;
      ({ xml, xmlHacienda } = await alanubeXmlFiles(
        cfg, String(i.fe_consecutivo), feKindOf(i.document_type), companyId));
    }
    // Con Facturemos —o si Alanube todavía no lo publica— sirve el guardado.
    if (!xml && i.fe_xml) xml = Buffer.from(String(i.fe_xml), 'utf8').toString('base64');
    else if (xml && !i.fe_xml) {
      // Se guarda la primera vez que se baja: así el comprobante sigue
      // descargable aunque después Alanube no responda.
      const plain = Buffer.from(xml, 'base64').toString('utf8');
      if (plain.trimStart().startsWith('<')) {
        await db.from('invoices').update({ fe_xml: plain })
          .eq('id', id).eq('tenant_id', tenantId).then(() => {}, () => {});
      }
    }

    if (!xml && !xmlHacienda) return fail(c, 'XML no disponible todavía', 404);
    return ok(c, {
      xml, xmlHacienda,
      filename: `${base}.xml`,
      filename_hacienda: `${base}-respuesta-hacienda.xml`,
    });
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
    const resp: any = await alanube.forTenant(cfg)
      .getDocumentPdf(String(docId), feKindOf((inv as any).document_type), String(companyId));
    const pdf = await toB64(resp?.pdf ?? deepFind(resp, /^pdf$/i, 12_000_000));
    if (!pdf) return fail(c, 'PDF no disponible en Alanube todavía', 404);
    return ok(c, { pdf, filename: `${(inv as any).fe_clave || id}.pdf` });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /consecutivo-audit?from=&to= — TRAZABILIDAD de la numeración.
//
// Para qué existe: al compartir un solo contador, cada serie quedó con huecos.
// Los huecos no provocan rechazo, pero en una fiscalización aparece la pregunta
// «¿dónde están los comprobantes faltantes?». Este reporte la contesta número por
// número: por cada hueco dice qué comprobante —de otra serie— consumió ese
// número, con su clave y su fecha. Deja de ser una laguna y pasa a ser un
// desglose verificable contra el ATV.
hacienda.get('/consecutivo-audit', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to = c.req.query('to');

    let q = db.from('invoices')
      .select('id, invoice_number, issued_at, created_at, total, document_type, '
        + 'fe_clave, fe_status, fe_nc_clave, fe_nc_status, fe_nd_clave, fe_nd_status')
      .eq('tenant_id', tenantId);
    if (from) q = q.gte('created_at', from);
    if (to) q = q.lte('created_at', endOfDay(to));
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const TIPO_LABEL: Record<string, string> = {
      '01': 'Factura', '02': 'Nota de débito', '03': 'Nota de crédito', '04': 'Tiquete',
    };

    /** El consecutivo de 20 díg va EMBEBIDO en la clave de 50: posiciones 21–40. */
    const parseClave = (clave: any) => {
      const k = String(clave ?? '').replace(/\D/g, '');
      if (k.length < 41) return null;
      const cons = k.slice(21, 41);
      return {
        consecutivo: cons,
        sucursal: cons.slice(0, 3),
        terminal: cons.slice(3, 8),
        tipo: cons.slice(8, 10),
        numero: parseInt(cons.slice(10), 10),
      };
    };

    interface Doc {
      serie: string; tipo: string; tipo_label: string; numero: number;
      consecutivo: string; clave: string; fecha: string; total: number;
      estado: string; factura: string;
    }
    const docs: Doc[] = [];
    const push = (clave: any, estado: any, r: any) => {
      const p = parseClave(clave);
      if (!p || !Number.isFinite(p.numero)) return;
      docs.push({
        serie: `${p.sucursal}-${p.terminal}`,
        tipo: p.tipo, tipo_label: TIPO_LABEL[p.tipo] ?? p.tipo,
        numero: p.numero, consecutivo: p.consecutivo,
        clave: String(clave), fecha: r.issued_at ?? r.created_at ?? '',
        total: Number(r.total ?? 0), estado: String(estado ?? ''),
        factura: String(r.invoice_number ?? ''),
      });
    };
    for (const r of (data ?? []) as any[]) {
      push(r.fe_clave, r.fe_status, r);
      push(r.fe_nc_clave, r.fe_nc_status, r);
      push(r.fe_nd_clave, r.fe_nd_status, r);
    }

    // Índice número → documentos que lo usaron (en cualquier serie/tipo).
    const byNumber = new Map<number, Doc[]>();
    for (const d of docs) {
      const arr = byNumber.get(d.numero) ?? [];
      arr.push(d);
      byNumber.set(d.numero, arr);
    }

    // Agrupar por serie+tipo y detectar huecos y repetidos.
    const groups = new Map<string, Doc[]>();
    for (const d of docs) {
      const k = `${d.serie}|${d.tipo}`;
      groups.set(k, [...(groups.get(k) ?? []), d]);
    }

    const series = [...groups.entries()].map(([key, list]) => {
      const [serie, tipo] = key.split('|');
      list.sort((a, b) => a.numero - b.numero);
      const nums = list.map(d => d.numero);
      const min = nums[0], max = nums[nums.length - 1];

      // Repetidos: ESTO sí es un problema real y hay que verlo de primero.
      const seen = new Map<number, number>();
      for (const n of nums) seen.set(n, (seen.get(n) ?? 0) + 1);
      const repetidos = [...seen.entries()].filter(([, n]) => n > 1).map(([num]) => num);

      // Huecos, cada uno con su explicación.
      const present = new Set(nums);
      const huecos: any[] = [];
      for (let n = min; n <= max; n++) {
        if (present.has(n)) continue;
        const usadoPor = (byNumber.get(n) ?? []).filter(d => d.tipo !== tipo);
        huecos.push({
          numero: n,
          explicado: usadoPor.length > 0,
          usado_por: usadoPor.map(d => ({
            tipo: d.tipo_label, consecutivo: d.consecutivo, clave: d.clave,
            fecha: d.fecha, total: d.total,
          })),
        });
      }

      return {
        serie, tipo, tipo_label: TIPO_LABEL[tipo] ?? tipo,
        emitidos: list.length, desde: min, hasta: max,
        huecos_total: huecos.length,
        huecos_explicados: huecos.filter(h => h.explicado).length,
        huecos_sin_explicar: huecos.filter(h => !h.explicado).length,
        repetidos,
        huecos,
        documentos: list,
      };
    }).sort((a, b) => a.serie.localeCompare(b.serie) || a.tipo.localeCompare(b.tipo));

    return ok(c, {
      generado: new Date().toISOString(),
      desde: from ?? null, hasta: to ?? null,
      total_documentos: docs.length,
      series,
      // Resumen para leer de un vistazo.
      resumen: {
        huecos_sin_explicar: series.reduce((s, x) => s + x.huecos_sin_explicar, 0),
        repetidos: series.reduce((s, x) => s + x.repetidos.length, 0),
      },
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * Mira en qué número va la serie SIN consumirlo.
 *
 * Es lo contrario de `reserveConsecutivo`: acá no se incrementa nada. Se usa en
 * la prueba en seco, donde reservar un número dejaría un hueco por haber
 * ensayado.
 */
async function peekConsecutivo(
  tenantId: string, tipo: string, floor: number, sucursal: string, terminal: string,
): Promise<string> {
  try {
    const suc = String(sucursal).replace(/\D/g, '').padStart(3, '0').slice(-3);
    const ter = String(terminal).replace(/\D/g, '').padStart(5, '0').slice(-5);
    const { data } = await db.from('fe_consecutivos')
      .select('last_number').eq('tenant_id', tenantId)
      .eq('sucursal', suc).eq('terminal', ter).eq('tipo', tipo).maybeSingle();
    const last = Number((data as any)?.last_number ?? 0);
    return String(Math.max(last + 1, floor, 1)).padStart(10, '0');
  } catch { return String(Math.max(floor, 1)).padStart(10, '0'); }
}

/**
 * Qué le falta al comprobante para poder salir.
 *
 * La prueba tiene que decir QUÉ está mal, no solo que algo lo está: Hacienda
 * responde con códigos que no le sirven a nadie en la caja.
 */
function previewChecks(
  cfg: any, emisor: any, receptor: any, lines: any[], tipoDoc: string,
): string[] {
  const f: string[] = [];
  if (!String(emisor?.identification ?? '').trim()) f.push('Falta la cédula del emisor.');
  if (!String(emisor?.name ?? '').trim()) f.push('Falta el nombre / razón social del emisor.');
  if (!String(emisor?.economic_activity_code ?? '').trim()) f.push('Falta la actividad económica del emisor.');
  if (!String(emisor?.email ?? '').trim()) f.push('Falta el correo del emisor.');
  if (tipoDoc === '01') {
    if (!receptor?.identification) f.push('Factura electrónica sin cédula del cliente.');
    if (!receptor?.email) f.push('El cliente no tiene correo: no se le podrá enviar el comprobante.');
  }
  lines.forEach((l: any, i: number) => {
    const cabys = String(l.cabys_code ?? l.cabys ?? '').replace(/\D/g, '');
    if (!cabys) f.push(`Línea ${i + 1} (${l.name ?? l.detail ?? '—'}): sin código CABYS.`);
    else if (cabys.length !== 13) f.push(`Línea ${i + 1}: CABYS de ${cabys.length} dígitos (deben ser 13).`);
    if (!(Number(l.quantity) > 0)) f.push(`Línea ${i + 1}: cantidad en cero.`);
  });
  if (String(cfg?.environment ?? 'production') === 'sandbox') {
    f.push('Ambiente de PRUEBAS (sandbox): lo que se emita acá no tiene validez fiscal.');
  }
  return f;
}

/**
 * Reserva el SIGUIENTE consecutivo de Hacienda para un tipo de comprobante.
 *
 * Cada tipo lleva su propia numeración (01 factura, 02 ND, 03 NC, 04 tiquete) y
 * tiene que ser consecutiva y sin repetir. La reserva se hace con una función
 * atómica en la base: con un SELECT-y-después-UPDATE, dos cajas facturando en el
 * mismo segundo se llevan el mismo número.
 *
 * Si la migración 83 todavía no corrió, cae a calcularlo desde `invoices` para
 * ese tipo. Ese respaldo NO es seguro entre cajas simultáneas — es solo para que
 * el negocio no se quede sin poder facturar mientras se corre la migración.
 */
export async function reserveConsecutivo(
  tenantId: string, tipo: string, floor: number,
  sucursal: string, terminal: string,
): Promise<string> {
  try {
    const { data, error } = await db.rpc('next_fe_consecutivo', {
      p_tenant: tenantId, p_tipo: tipo, p_floor: floor,
      p_sucursal: sucursal, p_terminal: terminal,
    });
    if (error) throw new Error(error.message);
    const n = Number(Array.isArray(data) ? data[0] : data);
    if (Number.isFinite(n) && n > 0) return String(n).padStart(10, '0');
    throw new Error('respuesta vacía');
  } catch (e: any) {
    console.warn('[fe] next_fe_consecutivo no disponible, usando respaldo:', e?.message);
    const docTypes = tipo === '01' ? ['factura_electronica']
      : tipo === '04' ? ['tiquete_electronico']
      : null;
    let max = 0;
    try {
      if (docTypes) {
        const { data } = await db.from('invoices')
          .select('invoice_number').eq('tenant_id', tenantId)
          .in('document_type', docTypes).not('fe_clave', 'is', null);
        for (const r of (data ?? []) as any[]) {
          const v = parseInt(String(r.invoice_number ?? '').replace(/\D/g, ''), 10);
          if (Number.isFinite(v)) max = Math.max(max, v);
        }
      } else {
        // NC/ND: sin columna propia, se parte del mayor número emitido en general
        // para no repetir ninguno de los que ya salieron con el número heredado.
        const { data } = await db.from('invoices')
          .select('invoice_number').eq('tenant_id', tenantId);
        for (const r of (data ?? []) as any[]) {
          const v = parseInt(String(r.invoice_number ?? '').replace(/\D/g, ''), 10);
          if (Number.isFinite(v)) max = Math.max(max, v);
        }
      }
    } catch { /* se usa el piso */ }
    return String(Math.max(max + 1, floor, 1)).padStart(10, '0');
  }
}

/**
 * Fuerza UN consecutivo concreto (re-emisión desde el panel admin).
 *
 * Existe porque el contador puede quedarse atrás de la realidad de Hacienda: si
 * el negocio emitió antes con otro sistema, o si un envío llegó a Hacienda pero
 * la respuesta se perdió, el sistema cree que el número está libre y Hacienda lo
 * rechaza con «numeration was already used». Ahí no hay nada que calcular: hay
 * que poder decirle «usá el 000260» y seguir.
 *
 * Además de devolver el número, ADELANTA el contador hasta él. Sin eso, la
 * siguiente venta normal volvería a intentar el número quemado y chocaría otra
 * vez. Nunca lo retrocede: bajar el contador sería garantizar el choque.
 */
export async function forceConsecutivo(
  tenantId: string, tipo: string, value: number,
  sucursal: string, terminal: string,
): Promise<string> {
  const n = Math.floor(value);
  try {
    const { data } = await db.from('fe_consecutivos')
      .select('last_number')
      .eq('tenant_id', tenantId).eq('sucursal', sucursal).eq('terminal', terminal).eq('tipo', tipo)
      .maybeSingle();
    const current = Number((data as any)?.last_number ?? 0);
    await db.from('fe_consecutivos').upsert({
      tenant_id: tenantId, sucursal, terminal, tipo,
      last_number: Math.max(current, n), updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,sucursal,terminal,tipo' });
  } catch (e: any) {
    // Si la tabla no existe todavía (migración 83 sin correr), igual se emite con
    // el número pedido: es justo lo que el admin quiso.
    console.warn('[fe] no se pudo adelantar el contador:', e?.message);
  }
  return String(n).padStart(10, '0');
}

/** Consecutivo configurado en Datos de FE ("Próx. …") según el tipo de documento.
 *  Es el SIGUIENTE número a emitir (0 si no está configurado). */
export function configuredNextConsecutivo(cfg: any, docType: string): number {
  // La nota de débito tiene su propio campo; si no se configuró, cae al de NC
  // por compatibilidad con lo que ya estaba guardado.
  const raw = docType === 'factura_electronica' ? cfg?.consecutivo_factura
    : docType === 'tiquete_electronico' ? cfg?.consecutivo_tiquete
    : docType === 'nota_debito' ? (cfg?.consecutivo_nd ?? cfg?.consecutivo_nc)
    : docType === 'nota_credito' ? cfg?.consecutivo_nc
    : null;
  const n = parseInt(String(raw ?? '').replace(/\D/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Próximo consecutivo (000001…). Respeta `floor` = consecutivo inicial
 *  configurado en Datos de FE (migración desde otro sistema): el resultado nunca
 *  es menor que ese número. */
export async function nextInvoiceNumber(tenantId: string, offset = 0, floor = 0): Promise<string> {
  // Paginado: sin esto, con >1000 facturas el máximo salía bajo → número duplicado.
  const PAGE = 1000;
  let maxSeq = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('invoices').select('invoice_number')
      .eq('tenant_id', tenantId).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) break;
    const chunk = (data ?? []) as any[];
    for (const r of chunk) {
      const s = String(r.invoice_number ?? '').trim();
      if (/^\d{1,10}$/.test(s)) maxSeq = Math.max(maxSeq, parseInt(s, 10));
    }
    if (chunk.length < PAGE) break;
  }
  // El próximo número es el mayor entre (máximo existente + 1) y el piso configurado.
  const next = Math.max(maxSeq + 1, floor) + offset;
  return String(next).padStart(6, '0');
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

    /**
     * PRUEBA EN SECO (`preview`).
     *
     * Arma el comprobante exactamente igual que una emisión real —mismos datos
     * del emisor, del cliente, los mismos productos y los mismos cálculos— pero:
     *   · NO crea la factura en la base,
     *   · NO consume un consecutivo (usa uno imaginario),
     *   · NO envía nada a Hacienda ni a Alanube.
     *
     * Sirve para ver qué saldría antes de quemar un consecutivo. Pasa por el
     * MISMO camino de código a propósito: una prueba que corre por otro lado no
     * prueba nada.
     */
    const preview = b.preview === true;
    const FAKE_CONSECUTIVO = '9999999999';

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
    const payment: string = ['cash', 'card', 'sinpe', 'credit', 'check', 'transfer', 'third_party', 'digital', 'other'].includes(b.payment_method) ? b.payment_method : 'cash';

    // Crear factura (consecutivo único). El piso = consecutivo inicial configurado
    // en Datos de FE (para continuar la numeración migrada de otro sistema).
    const consecFloor = configuredNextConsecutivo(cfg, docType);
    let inv: any = null, invErr: any = null, finalNumber = await nextInvoiceNumber(tenantId, 0, consecFloor);
    if (preview) {
      // Factura de mentira, solo para armar el documento. Nada se guarda.
      inv = {
        id: null, invoice_number: FAKE_CONSECUTIVO,
        issued_at: b.issued_at ?? new Date(Date.now() - 6 * 3600 * 1000).toISOString().replace('Z', ''),
      };
    }
    for (let attempt = 0; !preview && attempt < 8; attempt++) {
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
        // Hora de Costa Rica como "wall clock" (sin zona), igual que el POS, para
        // que la bitácora/FE facturas la muestren en hora CR (no UTC +6h).
        issued_at: b.issued_at ?? new Date(Date.now() - 6 * 3600 * 1000).toISOString().replace('Z', ''),
      }).select().single();
      if (!res.error) { inv = res.data; break; }
      invErr = res.error;
      if (!(String(invErr?.code) === '23505' || /duplicate/i.test(invErr?.message ?? ''))) break;
      finalNumber = await nextInvoiceNumber(tenantId, attempt + 1, consecFloor);
    }
    if (!inv) throw new Error(invErr?.message ?? 'No se pudo crear la factura');

    const itemRowsFe = rawLines
      .filter((l: any) => Number(l.quantity) > 0 && Number(l.unit_price) >= 0)
      .map((l: any) => ({
        invoice_id: inv.id, product_id: l.product_id ?? null,
        product_name: l.name ?? 'Producto',   // snapshot: sobrevive si se borra el producto
        quantity: Number(l.quantity),
        unit_price: Number(l.unit_price) || 0, discount_percent: 0, discount_amount: 0,
        subtotal: Math.round((Number(l.quantity) || 0) * (Number(l.unit_price) || 0) * 100) / 100,
      }));
    let { error: feItemErr } = preview
      ? { error: null } as any
      : await db.from('invoice_items').insert(itemRowsFe);
    if (feItemErr && /product_name/i.test(feItemErr.message)) {
      const stripped = itemRowsFe.map(({ product_name, ...r }: any) => r);
      ({ error: feItemErr } = await db.from('invoice_items').insert(stripped));
    }
    if (feItemErr) console.warn('[emit-direct] no se pudieron guardar los invoice_items:', feItemErr.message);

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
        headquarters: cfg.sucursal, terminal: terminalOf(c, cfg),
        // En la prueba se usa un consecutivo imaginario: reservar uno de verdad
        // lo quemaría y dejaría un hueco en la numeración por haber ensayado.
        numberOfDocument: preview ? FAKE_CONSECUTIVO : await reserveConsecutivo(
          tenantId, tipoDoc, consecFloor, String(cfg.sucursal ?? '1'), terminalOf(c, cfg)),
        // Empresa emisora del tenant (si no, Alanube usa la 'main' de la cuenta).
        senderId: (String(cfg.environment ?? 'production') === 'sandbox'
          ? cfg.alanube_company_id_sandbox : cfg.alanube_company_id_production) ?? cfg.alanube_company_id,
      });

      if (preview) {
        return ok(c, {
          ok: true, preview: true, provider: 'alanube', tipo: tipoDoc,
          document_type: docType,
          consecutivo_imaginario: `${String(cfg.sucursal ?? '1').padStart(3, '0')}`
            + `${terminalOf(c, cfg).padStart(5, '0')}${tipoDoc}${FAKE_CONSECUTIVO}`,
          proximo_consecutivo_real: await peekConsecutivo(
            tenantId, tipoDoc, consecFloor, String(cfg.sucursal ?? '1'), terminalOf(c, cfg)),
          ambiente: env,
          totales: { subtotal, iva: taxAmount, total },
          lineas: lines.length,
          faltantes: previewChecks(cfg, emisor, receptor, lines, tipoDoc),
          documento: doc,
        });
      }

      try {
        const resp: any = await alanube.forTenant(cfg).emitDocument(kind as any, doc, feCompanyId(cfg), { asCompany: cfg.alanube_company_type === 'associated' });
        const docObj = resp?.ticket ?? resp?.invoice ?? resp?.document ?? resp?.data ?? resp;
        const docId = docObj?.id ?? deepFind(resp, /(^id$|_id$|documentId$)/i, 10) ?? null;
        const clave = docObj?.key ?? docObj?.clave ?? deepFind(resp, /(clave|^key$)/i, 40) ?? null;
        const alanubeStatus = docObj?.status ?? null;
        await db.from('invoices').update({
          fe_clave: clave ?? docId, fe_consecutivo: docId, fe_status: 'sent', fe_situacion: '1', fe_environment: env, fe_error: null,
          fe_request: doc, fe_response: resp,
          updated_at: new Date().toISOString(),
        }).eq('id', inv.id).eq('tenant_id', tenantId);
        // Consecutivo REAL de Hacienda (20 díg) embebido en la clave (pos 22-41).
        const claveDig = String(clave ?? '').replace(/\D/g, '');
        const consecutivo = claveDig.length === 50 ? claveDig.slice(21, 41) : null;
        // El correo al cliente sale automáticamente al ACEPTARSE (dos XML + PDF).
        return ok(c, { ok: true, provider: 'alanube', invoice_id: inv.id, invoice_number: inv.invoice_number, clave, consecutivo, alanube_doc_id: docId, alanube_status: alanubeStatus, tipo: tipoDoc });
      } catch (emitErr: any) {
        const msg = emitErr instanceof AlanubeError ? friendlyAlanubeError(emitErr.message) : (emitErr?.message ?? 'Error emitiendo con Alanube');
        await db.from('invoices').update({ fe_status: 'error', fe_error: msg }).eq('id', inv.id).eq('tenant_id', tenantId);
        return fail(c, msg, 422);
      }
    }

    // ── Proveedor FACTUREMOS ──────────────────────────────────────────────────
    const sucursalDir = String(cfg.sucursal ?? '1');
    const terminalDir = terminalOf(c, cfg);
    const consecutivo = buildConsecutivo(invForDoc as any, {
      sucursal: sucursalDir, terminal: terminalDir, situacion: '1', tipoComprobante: tipoDoc,
      consecutivoInterno: preview ? FAKE_CONSECUTIVO : await reserveConsecutivo(
        tenantId, tipoDoc, consecFloor, sucursalDir, terminalDir),
    });
    const facturaJson = buildDocumentoJson(emisor, invForDoc as any, lines, receptor as any, { tipoComprobante: tipoDoc });

    if (preview) {
      return ok(c, {
        ok: true, preview: true, provider: 'facturemos', tipo: tipoDoc,
        document_type: docType,
        consecutivo_imaginario: `${consecutivo.Sucursal}${consecutivo.Terminal}`
          + `${consecutivo.TipoComprobante}${consecutivo.ConsecutivoInterno}`,
        proximo_consecutivo_real: await peekConsecutivo(
          tenantId, tipoDoc, consecFloor, sucursalDir, terminalDir),
        ambiente: env,
        totales: { subtotal, iva: taxAmount, total },
        lineas: lines.length,
        faltantes: previewChecks(cfg, emisor, receptor, lines, tipoDoc),
        documento: { ConsecutivoModel: consecutivo, FacturaJson: facturaJson },
      });
    }

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
