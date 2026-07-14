import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { obtenerToken, consultaEstatus, enviaDocumentoConsecutivoJson, FacturemosError } from '../services/facturemos.js';
import { buildConsecutivo, buildDocumentoJson, tipoComprobante, type FELine } from '../services/feDocument.js';
import { alanube, AlanubeError } from '../services/alanube.js';
import { buildAlanubeDocument } from '../services/alanubeDocument.js';
import { endOfDay } from '../utils/dateRange.js';
import { sendEmail } from '../services/emailService.js';

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

  // Comprobantes emitidos DESDE el inicio de la bolsa vigente.
  const { count: usedDocs } = await db.from('invoices')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
    .not('fe_clave', 'is', null).gte('created_at', startISO);
  const { count: usedNc } = await db.from('invoices')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
    .not('fe_nc_clave', 'is', null).gte('created_at', startISO);

  const used = (usedDocs ?? 0) + (usedNc ?? 0);             // facturas + tiquetes + NC
  const available = included > 0 ? included - used : null;  // null = ilimitado
  const overage = included > 0 ? Math.max(0, used - included) : 0;

  return {
    included, extra_fee: extraFee, quota_start: startISO, months_elapsed: 1,
    used, used_docs: usedDocs ?? 0, used_nc: usedNc ?? 0,
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

/** Mapea el status de Alanube (REGISTERED/ACCEPTED/REJECTED…) a fe_status. */
function mapAlanubeStatus(s: any): string {
  const t = String(s ?? '').toUpperCase();
  if (t.includes('ACCEPT') || t.includes('ACEPT')) return 'accepted';
  if (t.includes('REJECT') || t.includes('RECHAZ')) return 'rejected';
  if (t.includes('ERROR')) return 'error';
  return 'sent';   // REGISTERED / PENDING / PROCESSING…
}

/** Consulta el estado de un documento en Alanube por su id (ULID). Devuelve
 *  también la clave real de Hacienda (50 díg) si ya está disponible. */
async function alanubeDocStatus(docId: string): Promise<{ status: string; clave: string | null; raw: any }> {
  const doc: any = await alanube.getDocument(docId);
  const d = doc?.ticket ?? doc?.invoice ?? doc?.creditNote ?? doc?.document ?? doc?.data ?? doc;
  const rawStatus = d?.status ?? deepFind(doc, /(^status$|estado|indEstado|situacion)/i, 20);
  const clave = d?.key ?? d?.clave ?? deepFind(doc, /(clave|^key$)/i, 40) ?? null;
  return { status: mapAlanubeStatus(rawStatus), clave, raw: doc };
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
      .select('id, fe_clave, fe_consecutivo').eq('id', invoice_id).eq('tenant_id', tenantId).maybeSingle();
    if (!(inv as any)?.fe_clave) return fail(c, 'La factura no fue emitida', 422);

    let fe_status = 'sent';
    const patch: Record<string, any> = { updated_at: new Date().toISOString() };
    let indEstado: any = null, errDetail: any = null;
    if (provider === 'alanube') {
      const docId = (inv as any).fe_consecutivo;
      if (!docId) return fail(c, 'No hay id de documento de Alanube para consultar. Volvé a emitir.', 422);
      const r = await alanubeDocStatus(docId);
      fe_status = r.status; indEstado = r.status;
      patch.fe_status = fe_status;
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
    await db.from('invoices').update(patch).eq('id', invoice_id).eq('tenant_id', tenantId);

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
      .select('id, fe_clave, fe_consecutivo')
      .eq('tenant_id', tenantId).eq('fe_status', 'sent').not('fe_clave', 'is', null)
      .order('issued_at', { ascending: false }).limit(60);

    let updated = 0;
    for (const inv of (pend ?? []) as any[]) {
      try {
        let fe_status = 'sent';
        const patch: Record<string, any> = { updated_at: new Date().toISOString() };
        if (provider === 'alanube') {
          if (!inv.fe_consecutivo) continue;   // sin id de Alanube no podemos consultar
          const r = await alanubeDocStatus(inv.fe_consecutivo);
          fe_status = r.status;
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

    const items: any[] = (inv as any).invoice_items ?? [];
    const pids = [...new Set(items.map(it => it.product_id).filter(Boolean))];
    const prodMap = new Map<string, any>();
    if (pids.length > 0) {
      const { data: prods } = await db.from('products')
        .select('id, name, sku, cabys_code, iva_rate, unit_type:unit_types(abbreviation)').in('id', pids as string[]);
      for (const p of prods ?? []) prodMap.set((p as any).id, p);
    }
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
      });
      if (debug) {
        return ok(c, { provider: 'alanube', environment: env, kind, company_id: cfg.alanube_company_id, payload: doc });
      }
      let resp: any;
      try {
        resp = await alanube.emitDocument(kind as any, doc, cfg.alanube_company_id);
      } catch (e: any) {
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
        fe_error: null,
        document_type: tipoDoc === '01' ? 'factura_electronica' : 'tiquete_electronico',
        sale_condition: (inv as any).payment_method === 'credit' ? '02' : '01',
        updated_at: new Date().toISOString(),
      }).eq('id', invoice_id).eq('tenant_id', tenantId);
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
    if (provider === 'alanube' && !cfg.alanube_company_id) return fail(c, 'La empresa no está dada de alta en Alanube.', 422);
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
        .select('id, name, sku, cabys_code, iva_rate, unit_type:unit_types(abbreviation)').in('id', pids as string[]);
      for (const p of prods ?? []) prodMap.set((p as any).id, p);
    }
    const lines: FELine[] = items.map((it: any) => {
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
        resp = await alanube.emitDocument('credit-note', doc, cfg.alanube_company_id);
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
    if (provider === 'alanube' && !cfg.alanube_company_id) return fail(c, 'La empresa no está dada de alta en Alanube.', 422);
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
        .select('id, name, sku, cabys_code, iva_rate, unit_type:unit_types(abbreviation)').in('id', pids as string[]);
      for (const p of prods ?? []) prodMap.set((p as any).id, p);
    }
    const lines: FELine[] = items.map((it: any) => {
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
        resp = await alanube.emitDocument('debit-note', doc, cfg.alanube_company_id);
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
    const base = 'id, invoice_number, customer_name, total, issued_at, document_type, payment_method, status, fe_clave, fe_consecutivo, fe_status, fe_error';
    // Intento con columnas de NC y ND; si alguna no existe (migración sin correr),
    // reintentamos con menos columnas.
    let { data, error } = await buildQuery(`${base}, fe_nc_clave, fe_nc_status, fe_nd_clave, fe_nd_status`);
    if (error && /fe_nd_/.test(error.message)) {
      ({ data, error } = await buildQuery(`${base}, fe_nc_clave, fe_nc_status`));   // sin ND
    }
    if (error && /fe_nc_/.test(error.message)) {
      ({ data, error } = await buildQuery(base));   // sin NC ni ND
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
hacienda.get('/received', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const cfg = await loadFEConfig(tenantId);
    if (cfg.fe_provider !== 'alanube') return fail(c, 'La recepción de comprobantes está disponible con Alanube.', 409);

    const { data, error } = await db.from('received_documents')
      .select('*').eq('tenant_id', tenantId)
      .order('doc_date', { ascending: false }).limit(300);
    if (error) {
      // Si la tabla aún no existe (migración sin correr), devolvemos vacío con nota.
      if (/received_documents/.test(error.message)) return ok(c, []);
      throw new Error(error.message);
    }
    return ok(c, (data ?? []).map((d: any) => ({
      id: d.id, clave: d.clave, issuer_name: d.issuer_name, issuer_id: d.issuer_id,
      document_type: d.document_type, date: d.doc_date, total: Number(d.total ?? 0),
      tax: Number(d.tax ?? 0), ack_status: d.ack_status,
      kind: d.kind ?? null, items: d.items ?? null,
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
    if (cfg.fe_provider !== 'alanube') return fail(c, 'La recepción de comprobantes está disponible con Alanube.', 409);
    if (!cfg.alanube_company_id) return fail(c, 'La empresa no está dada de alta en Alanube.', 422);

    const { data: doc } = await db.from('received_documents')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!doc) return fail(c, 'Comprobante recibido no encontrado', 404);

    // Mensaje Receptor CRI: { idDoc, sender, receiver, information, totals }.
    // Nombres nested best-guess — se afinan contra la validación del sandbox.
    const d = doc as any;
    const totalTax = Number(d.tax ?? 0);
    const total = Number(d.total ?? 0);
    const payload: Record<string, any> = {
      idDoc: {
        key: d.clave,
        headquarters: String(cfg.sucursal ?? '1').replace(/\D/g, '').padStart(3, '0').slice(-3),
        terminal: String(cfg.terminal ?? '1').replace(/\D/g, '').padStart(5, '0').slice(-5),
      },
      sender: { identificationNumber: String(d.issuer_id ?? '').replace(/\D/g, '') },
      receiver: {
        identificationType: cfg.emisor_identification_type ?? '02',
        identificationNumber: String(cfg.emisor_identification ?? '').replace(/\D/g, ''),
      },
      information: {
        message: st,                                   // 1 aceptación, 3 rechazo
        ...(st === '3' && reason ? { detailMessage: String(reason) } : {}),
        economicActivity: String(cfg.economic_activity_code ?? '').trim(),
      },
      totals: { totalTax: totalTax.toFixed(2), totalVoucher: total.toFixed(2) },
    };

    let resp: any;
    try {
      resp = await alanube.sendReceiverMessage(payload, cfg.alanube_company_id);
    } catch (e: any) {
      return fail(c, e instanceof AlanubeError ? e.message : (e?.message ?? 'Error enviando el mensaje receptor'), 422);
    }
    const mrId = resp?.id ?? deepFind(resp, /(^id$|_id$)/i, 40) ?? null;
    await db.from('received_documents').update({
      ack_status: st === '1' ? 'accepted' : 'rejected', ack_id: mrId, updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId);
    return ok(c, { ok: true, state: st, mr_id: mrId, response: resp });
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
/** Arma y envía el correo del comprobante electrónico. Adjunta el XML si existe. */
async function sendComprobanteEmail(to: string, i: {
  invoice_number: string; fe_clave: string; fe_consecutivo?: string | null;
  fe_status?: string | null; total?: number | null; customer_name?: string | null; fe_xml?: string | null;
}): Promise<void> {
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
  const attachments = i.fe_xml
    ? [{ filename: `${i.fe_clave}.xml`, content: Buffer.from(String(i.fe_xml), 'utf8').toString('base64') }]
    : undefined;
  await sendEmail({ to, subject: `Comprobante electrónico ${i.invoice_number}`, html, attachments });
}

hacienda.post('/resend-email', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { invoice_id, email } = await c.req.json().catch(() => ({}));
    if (!invoice_id || !email) return fail(c, 'Falta invoice_id o email', 422);

    const { data: inv } = await db.from('invoices')
      .select('invoice_number, fe_clave, fe_consecutivo, fe_status, fe_xml, total, customer_name')
      .eq('id', invoice_id).eq('tenant_id', tenantId).maybeSingle();
    if (!inv) return fail(c, 'Factura no encontrada', 404);
    if (!(inv as any).fe_clave) return fail(c, 'La factura no fue emitida electrónicamente', 422);

    await sendComprobanteEmail(email, inv as any);
    return ok(c, { ok: true });
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
    if (provider === 'alanube' && !cfg.alanube_company_id) return fail(c, 'La empresa no está dada de alta en Alanube.', 422);
    const env = cfg.environment === 'sandbox' ? 'sandbox' : 'production'; // default producción
    const defaultCabys = String(cfg.default_cabys ?? '').replace(/\D/g, '') || null;

    // Normalizar líneas + totales.
    const lines: FELine[] = rawLines.map((l: any) => {
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
      });
      try {
        const resp: any = await alanube.emitDocument(kind as any, doc, cfg.alanube_company_id);
        const docObj = resp?.ticket ?? resp?.invoice ?? resp?.document ?? resp?.data ?? resp;
        const docId = docObj?.id ?? deepFind(resp, /(^id$|_id$|documentId$)/i, 10) ?? null;
        const clave = docObj?.key ?? docObj?.clave ?? deepFind(resp, /(clave|^key$)/i, 40) ?? null;
        const alanubeStatus = docObj?.status ?? null;
        await db.from('invoices').update({
          fe_clave: clave ?? docId, fe_consecutivo: docId, fe_status: 'sent', fe_situacion: '1', fe_error: null,
          updated_at: new Date().toISOString(),
        }).eq('id', inv.id).eq('tenant_id', tenantId);
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
        fe_clave: clave, fe_consecutivo: consec, fe_status: 'sent', fe_situacion: '1',
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
