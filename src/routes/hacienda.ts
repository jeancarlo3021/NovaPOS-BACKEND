import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { obtenerToken, consultaEstatus, enviaDocumentoConsecutivoJson, FacturemosError } from '../services/facturemos.js';
import { buildConsecutivo, buildDocumentoJson, tipoComprobante, type FELine } from '../services/feDocument.js';

const hacienda = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/** Carga la config de FE del tenant (settings type='electronic-invoice'). */
async function loadFEConfig(tenantId: string): Promise<any> {
  const { data } = await db.from('settings').select('config')
    .eq('tenant_id', tenantId).eq('type', 'electronic-invoice').maybeSingle();
  return (data as any)?.config ?? {};
}

// POST /test-connection — verifica que el ApiKeyCliente (servidor) obtenga token
// para el ambiente configurado por el tenant. No emite nada.
hacienda.post('/test-connection', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const cfg = await loadFEConfig(tenantId);
    const env = cfg.environment === 'production' ? 'production' : 'sandbox';

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
    const env = cfg.environment === 'production' ? 'production' : 'sandbox';
    const data = await consultaEstatus(env, cfg.api_key_emisor, clave);
    return ok(c, data);
  } catch (err: any) {
    const status = err instanceof FacturemosError ? err.status : 500;
    return fail(c, err.message, status);
  }
});

/** Mapea el Ind_estado de Hacienda a nuestro fe_status. */
function mapEstado(ind: string): string {
  const s = String(ind ?? '').toLowerCase();
  if (s.includes('acept')) return 'accepted';
  if (s.includes('rechaz')) return 'rejected';
  return 'sent';   // procesando / recibido
}

// POST /refresh-status — consulta el estatus de una factura por su Clave y lo GUARDA.
hacienda.post('/refresh-status', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { invoice_id } = await c.req.json().catch(() => ({}));
    if (!invoice_id) return fail(c, 'Falta invoice_id', 422);

    const cfg = await loadFEConfig(tenantId);
    if (!cfg.api_key_emisor) return fail(c, 'Falta configurar la ApiKey del emisor', 422);
    const env = cfg.environment === 'production' ? 'production' : 'sandbox';

    const { data: inv } = await db.from('invoices')
      .select('id, fe_clave').eq('id', invoice_id).eq('tenant_id', tenantId).maybeSingle();
    if (!(inv as any)?.fe_clave) return fail(c, 'La factura no fue emitida', 422);

    const data = await consultaEstatus(env, cfg.api_key_emisor, (inv as any).fe_clave);
    const fe_status = mapEstado(data?.Ind_estado);

    await db.from('invoices').update({
      fe_status,
      fe_xml: data?.Respuesta_xml ?? null,
      fe_error: data?.Error ?? null,
      updated_at: new Date().toISOString(),
    }).eq('id', invoice_id).eq('tenant_id', tenantId);

    return ok(c, { fe_status, ind_estado: data?.Ind_estado ?? null, error: data?.Error ?? null });
  } catch (err: any) {
    const status = err instanceof FacturemosError ? err.status : 500;
    return fail(c, err.message, status);
  }
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
    if (!cfg.api_key_emisor) return fail(c, 'Falta configurar la ApiKey del emisor', 422);
    const env = cfg.environment === 'production' ? 'production' : 'sandbox';

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
    const lines: FELine[] = items.map((it: any) => {
      const p = prodMap.get(it.product_id) ?? {};
      return {
        product_name: p.name ?? 'Producto',
        sku: p.sku ?? null,
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price),
        subtotal: Number(it.subtotal),
        cabys_code: p.cabys_code ?? null,
        iva_rate: p.iva_rate ?? 0,
        unit: (p.unit_type?.abbreviation) ?? 'Unid',
      };
    }).filter((l: FELine) => Number(l.quantity) > 0 && l.product_name);
    if (lines.length === 0) return fail(c, 'La factura no tiene líneas de detalle para emitir.', 422);

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
      proveedor_sistemas: cfg.proveedor_sistemas ?? '',
    };

    // Tipo de comprobante según lo elegido en el POS (columna document_type):
    //   factura_electronica → 01 · tiquete_electronico/ticket → 04.
    // La factura exige receptor identificado (cédula), si no la rechaza Hacienda.
    const receptorConCedula = !!(receptor?.identification && receptor?.identification_type);
    const tipoDoc = (inv as any).document_type === 'factura_electronica' ? '01' : '04';
    if (tipoDoc === '01' && !receptorConCedula) {
      return fail(c, 'Para emitir Factura Electrónica el cliente debe tener cédula (identificación). Seleccioná un cliente registrado con identificación o emití como tiquete.', 422);
    }

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
    // Guardar el error en la factura para diagnóstico.
    if (invoice_id) {
      try {
        await db.from('invoices').update({ fe_status: 'error', fe_error: err.message })
          .eq('id', invoice_id).eq('tenant_id', tenantId);
      } catch { /* ignore */ }
    }
    return fail(c, err.message, status);
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
    if (!cfg.api_key_emisor) return fail(c, 'Falta configurar la ApiKey del emisor', 422);
    const env = cfg.environment === 'production' ? 'production' : 'sandbox';

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

    // Consecutivo de NC (TipoComprobante 03) y referencia al documento original.
    const consecutivo = buildConsecutivo(inv as any, {
      sucursal: cfg.sucursal, terminal: cfg.terminal, situacion: '1', tipoComprobante: '03',
    });
    const tipoOriginal = tipoComprobante((inv as any).document_type);   // 04 tiquete / 01 factura
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
    return fail(c, err.message, status);
  }
});

// Alias legado.
hacienda.post('/cancel', (c: any) => c.json({ data: null, error: 'Usá /credit-note' }, 400));

export default hacienda;
