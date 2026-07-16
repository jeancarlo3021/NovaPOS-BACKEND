import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { autoSendComprobanteToCustomer } from './hacienda.js';

// Rutas PÚBLICAS para webhooks entrantes (Alanube nos llama; no hay sesión).
// Se monta FUERA del middleware de auth. Se valida por un secreto compartido.
const webhooks = new Hono();

/** Busca recursivamente el primer valor cuya clave matchee `re` (string/número). */
function deepFind(obj: any, re: RegExp, maxLen = 60, depth = 0): string | null {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      const s = String(v);
      if (s && s.length <= maxLen) return s;
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = deepFind(v, re, maxLen, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// GET /webhooks/alanube — diagnóstico: confirma que la ruta pública existe y
// responde SIN pedir token (Alanube usa POST; esto es solo para probar en el
// navegador que el webhook está desplegado y accesible).
webhooks.get('/alanube', (c) => c.json({
  ok: true, webhook: 'alanube', method_expected: 'POST',
  secret_configured: !!(process.env.ALANUBE_WEBHOOK_SECRET || '').trim(),
}));

// POST /webhooks/alanube — notificaciones de Alanube (evento documents.reception:
// un proveedor emitió un comprobante hacia la cédula del tenant).
webhooks.post('/alanube', async (c) => {
  try {
    // Verificación: header x-api-key (configurado en el webhook de Alanube) o ?token=.
    const provided = c.req.header('x-api-key') ?? c.req.query('token') ?? '';
    const secret = (process.env.ALANUBE_WEBHOOK_SECRET || '').trim();
    if (!secret || provided !== secret) return fail(c, 'No autorizado', 401);

    const body = await c.req.json().catch(() => ({}));
    const event = String(body?.event ?? body?.type ?? '').toLowerCase();

    const d: any = body?.document ?? body?.data ?? body?.payload ?? body;
    const clave = d?.key ?? d?.clave ?? deepFind(body, /(clave|^key$)/i, 50);
    if (!clave) return ok(c, { ignored: true, reason: 'sin clave' });
    const claveDigits = String(clave).replace(/\D/g, '');
    const docId = d?.id ?? deepFind(body, /(^id$|documentId)/i, 40);

    // ── Estado de EMISIÓN: si la clave/id corresponde a una factura que emitimos,
    //    actualizamos su fe_status (Aceptado/Rechazado) — llega por el webhook.
    const rawStatus = d?.haciendaStatus ?? d?.indEstado ?? d?.status
      ?? deepFind(body, /(indEstado|haciendaStatus|^status$|estado)/i, 30);
    const mapStatus = (s: any): string => {
      const t = String(s ?? '').toUpperCase().trim();
      if (t.includes('ACCEPT') || t.includes('ACEPT') || t.includes('APROB') || t === '1') return 'accepted';
      if (t.includes('REJECT') || t.includes('RECHAZ') || t === '2') return 'rejected';
      if (t.includes('ERROR') || t.includes('FAIL')) return 'error';
      return 'sent';
    };
    if (!event.includes('recep')) {
      const feStatus = mapStatus(rawStatus);
      const filters = [claveDigits ? `fe_clave.eq.${claveDigits}` : null, docId ? `fe_consecutivo.eq.${docId}` : null].filter(Boolean).join(',');
      if (filters) {
        let res = await db.from('invoices')
          .update({ fe_status: feStatus, fe_response: body, updated_at: new Date().toISOString() })
          .or(filters).select('id, tenant_id');
        if (res.error && /fe_response/.test(res.error.message)) {   // migración 55 sin correr
          res = await db.from('invoices')
            .update({ fe_status: feStatus, updated_at: new Date().toISOString() })
            .or(filters).select('id, tenant_id');
        }
        if (res.data && res.data.length) {
          // Al ACEPTARSE, enviar automáticamente el comprobante completo al cliente.
          if (feStatus === 'accepted') {
            for (const row of res.data as any[]) autoSendComprobanteToCustomer(row.tenant_id, row.id);
          }
          return ok(c, { ok: true, kind: 'emission', fe_status: feStatus });
        }
      }
      // No matcheó ninguna factura emitida y no es recepción → se ignora.
      if (event && !event.includes('recep')) return ok(c, { ignored: true, event });
    }

    // El tenant se resuelve por la cédula RECEPTORA del documento.
    const receiverId = String(
      d?.receiverIdentification ?? deepFind(body, /(receiverId|receiverIdentification|cedulaReceptor|receptor.*ident)/i, 30) ?? ''
    ).replace(/\D/g, '');
    if (!receiverId) return ok(c, { ignored: true, reason: 'sin cédula receptora' });

    const { data: rows } = await db.from('settings').select('tenant_id, config').eq('type', 'electronic-invoice');
    let tenantId: string | null = null;
    for (const r of (rows ?? []) as any[]) {
      const cedula = String(r.config?.emisor_identification ?? '').replace(/\D/g, '');
      if (cedula && cedula === receiverId) { tenantId = r.tenant_id; break; }
    }
    if (!tenantId) return ok(c, { ignored: true, reason: 'tenant no encontrado' });

    await db.from('received_documents').upsert({
      tenant_id: tenantId,
      alanube_doc_id: d?.id ?? deepFind(body, /(^id$|documentId)/i, 40),
      clave: String(clave).replace(/\D/g, ''),
      issuer_name: d?.issuerName ?? d?.senderName ?? deepFind(body, /(issuerName|senderName|razonSocial|nombreEmisor)/i, 120),
      issuer_id: d?.issuerIdentification ?? deepFind(body, /(issuerId|issuerIdentification|cedulaEmisor)/i, 30),
      document_type: d?.documentType ?? deepFind(body, /(documentType|tipoDoc)/i, 5),
      doc_date: d?.issueDate ?? d?.date ?? new Date().toISOString(),
      total: Number(d?.total ?? deepFind(body, /(totalVoucher|totalComprobante|^total$)/i, 20) ?? 0) || 0,
      tax: Number(deepFind(body, /(totalTax|totalImpuesto)/i, 20) ?? 0) || 0,
      ack_status: 'pending',
      raw: body,
    }, { onConflict: 'tenant_id,clave' });

    return ok(c, { ok: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default webhooks;
