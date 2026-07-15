// ─────────────────────────────────────────────────────────────────────────────
//  Recepción de facturas de COMPRA por CORREO.
//
//  Reemplaza el flujo de Alanube (cuya documentación de recepción no funcionaba).
//  Un buzón CENTRAL recibe los XML que Hacienda/los proveedores envían. Un cron
//  externo (cron-job.org) llama cada 15 min a POST /cron/fetch-received-emails,
//  que ejecuta `fetchAndProcessReceivedEmails()`:
//
//    1. Conecta por IMAP al buzón central (credenciales en variables de entorno).
//    2. Lee los correos NO leídos y saca los adjuntos XML.
//    3. Parsea cada comprobante electrónico (FE/TE/NC/ND de Hacienda v4.x).
//    4. Mapea el RECEPTOR (cédula) → tenant (por su cédula de emisor en la config FE).
//    5. Registra el comprobante en la bandeja `received_documents`.
//    6. Crea un BORRADOR de compra (proveedor + total) para revisar/aprobar.
//    7. Marca el correo como leído.
//
//  Todo es tolerante a fallos: un correo/adjunto malo no aborta el lote.
// ─────────────────────────────────────────────────────────────────────────────
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { XMLParser } from 'fast-xml-parser';
import { db } from '../db/client.js';

// ── Tipos ────────────────────────────────────────────────────────────────────
interface ParsedLine {
  detail: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  tax: number;
}
interface ParsedDoc {
  clave: string;
  docType: string;              // 01 factura · 04 tiquete · 03 NC · 02 ND
  date: string | null;          // ISO
  issuer: { name: string; id: string };   // proveedor (emisor del XML)
  receiver: { name: string; id: string }; // nuestra empresa (receptor)
  total: number;
  tax: number;
  lines: ParsedLine[];
}

// Mapea el nombre de la raíz del XML al tipo de comprobante de Hacienda.
const ROOT_TO_TYPE: Record<string, string> = {
  FacturaElectronica: '01',
  TiqueteElectronico: '04',
  NotaCreditoElectronica: '03',
  NotaDebitoElectronica: '02',
  FacturaElectronicaCompra: '08',
  FacturaElectronicaExportacion: '09',
};

const num = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: any): string => (v == null ? '' : String(v)).trim();

// ── Parseo del XML de Hacienda ───────────────────────────────────────────────
// Devuelve null si el XML no es un comprobante electrónico (ej. es la respuesta
// "MensajeHacienda" de aceptación, que no nos interesa recepcionar).
export function parseHaciendaXml(xml: string): ParsedDoc | null {
  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: true });
  let obj: any;
  try { obj = parser.parse(xml); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const rootKey = Object.keys(obj).find(k => k in ROOT_TO_TYPE);
  if (!rootKey) return null;                     // no es un comprobante emitible
  const root = obj[rootKey];
  if (!root || typeof root !== 'object') return null;

  const emisor = root.Emisor ?? {};
  const receptor = root.Receptor ?? {};
  const resumen = root.ResumenFactura ?? {};

  // Líneas de detalle (una o varias).
  const detalle = root.DetalleServicio?.LineaDetalle;
  const rawLines: any[] = Array.isArray(detalle) ? detalle : detalle ? [detalle] : [];
  const lines: ParsedLine[] = rawLines.map(l => ({
    detail: str(l.Detalle),
    quantity: num(l.Cantidad) || 1,
    unit_price: num(l.PrecioUnitario),
    subtotal: num(l.SubTotal ?? l.MontoTotal),
    tax: num(l.Impuesto?.Monto ?? (Array.isArray(l.Impuesto) ? l.Impuesto.reduce((s: number, i: any) => s + num(i.Monto), 0) : 0)),
  }));

  return {
    clave: str(root.Clave),
    docType: ROOT_TO_TYPE[rootKey],
    date: root.FechaEmision ? new Date(str(root.FechaEmision)).toISOString() : null,
    issuer: {
      name: str(emisor.Nombre),
      id: str(emisor.Identificacion?.Numero),
    },
    receiver: {
      name: str(receptor.Nombre),
      id: str(receptor.Identificacion?.Numero),
    },
    total: num(resumen.TotalComprobante),
    tax: num(resumen.TotalImpuesto),
    lines,
  };
}

// ── Mapeo receptor → tenant ──────────────────────────────────────────────────
// Busca el tenant cuya config de FE tenga `emisor_identification` == cédula del
// receptor. Cachea todas las configs en una sola query por corrida.
async function loadTenantByReceiverIndex(): Promise<Map<string, string>> {
  const idx = new Map<string, string>();
  const { data } = await db.from('settings').select('tenant_id, config').eq('type', 'electronic-invoice');
  for (const row of (data ?? []) as any[]) {
    const ced = str(row.config?.emisor_identification);
    if (ced) idx.set(ced, row.tenant_id);
  }
  return idx;
}

// ── Proveedor: buscar por cédula (tax_id) o crear ────────────────────────────
async function findOrCreateSupplier(tenantId: string, issuer: { name: string; id: string }): Promise<string | null> {
  if (issuer.id) {
    const { data: found } = await db.from('suppliers')
      .select('id').eq('tenant_id', tenantId).eq('tax_id', issuer.id).maybeSingle();
    if (found?.id) return found.id;
  }
  const { data: created, error } = await db.from('suppliers')
    .insert({ tenant_id: tenantId, name: issuer.name || `Proveedor ${issuer.id || ''}`.trim(), tax_id: issuer.id || null })
    .select('id').single();
  if (error) { console.warn('[recepción] no se pudo crear proveedor:', error.message); return null; }
  return created.id;
}

// ── Borrador de compra desde el comprobante ──────────────────────────────────
async function createPurchaseDraft(tenantId: string, doc: ParsedDoc, supplierId: string): Promise<string | null> {
  const purchaseNumber = `REC-${(doc.clave || Date.now().toString()).slice(-10)}`;
  const notes = `Recepción automática por correo · ${doc.issuer.name} · Clave ${doc.clave}\n`
    + doc.lines.map(l => `• ${l.quantity} × ${l.detail} = ₡${l.subtotal}`).join('\n');
  const { data, error } = await db.from('purchases')
    .insert({
      tenant_id: tenantId,
      supplier_id: supplierId,
      purchase_number: purchaseNumber,
      purchase_date: doc.date ?? new Date().toISOString(),
      status: 'pending',                 // borrador — se revisa y recibe manualmente
      total_amount: doc.total,
      notes,
    })
    .select('id').single();
  if (error) { console.warn('[recepción] no se pudo crear compra:', error.message); return null; }
  return data.id;
}

// ── Procesa UN comprobante XML ───────────────────────────────────────────────
async function processXml(
  xml: string,
  emailFrom: string,
  tenantIndex: Map<string, string>,
): Promise<'ok' | 'skip' | 'no-tenant' | 'dup' | 'error'> {
  const doc = parseHaciendaXml(xml);
  if (!doc || !doc.clave) return 'skip';

  const tenantId = tenantIndex.get(doc.receiver.id);
  if (!tenantId) return 'no-tenant';       // ninguna empresa con esa cédula de receptor

  // ¿Ya está en la bandeja? (unique tenant_id + clave)
  const { data: existing } = await db.from('received_documents')
    .select('id').eq('tenant_id', tenantId).eq('clave', doc.clave).maybeSingle();
  if (existing?.id) return 'dup';

  const supplierId = await findOrCreateSupplier(tenantId, doc.issuer);
  const purchaseId = supplierId ? await createPurchaseDraft(tenantId, doc, supplierId) : null;

  const { error } = await db.from('received_documents').insert({
    tenant_id: tenantId,
    clave: doc.clave,
    issuer_name: doc.issuer.name,
    issuer_id: doc.issuer.id,
    document_type: doc.docType,
    doc_date: doc.date,
    total: doc.total,
    tax: doc.tax,
    ack_status: 'pending',
    source: 'email',
    email_from: emailFrom,
    receiver_id: doc.receiver.id,
    xml,
    purchase_id: purchaseId,
    raw: { lines: doc.lines, receiver: doc.receiver },
  });
  if (error) {
    // La columna extra puede no existir si no se corrió la migración 53: reintenta mínimo.
    if (/column .* does not exist/i.test(error.message)) {
      await db.from('received_documents').insert({
        tenant_id: tenantId, clave: doc.clave, issuer_name: doc.issuer.name, issuer_id: doc.issuer.id,
        document_type: doc.docType, doc_date: doc.date, total: doc.total, tax: doc.tax,
        ack_status: 'pending', raw: { lines: doc.lines },
      });
      return 'ok';
    }
    console.warn('[recepción] insert bandeja falló:', error.message);
    return 'error';
  }
  return 'ok';
}

export interface ReceiveSummary {
  scanned: number; processed: number; duplicates: number;
  noTenant: number; skipped: number; errors: number;
}

// ── Entrada principal: lee el buzón y procesa ────────────────────────────────
export async function fetchAndProcessReceivedEmails(): Promise<ReceiveSummary> {
  const summary: ReceiveSummary = { scanned: 0, processed: 0, duplicates: 0, noTenant: 0, skipped: 0, errors: 0 };

  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!host || !user || !pass) {
    throw new Error('Faltan credenciales IMAP (IMAP_HOST, IMAP_USER, IMAP_PASS).');
  }

  const client = new ImapFlow({
    host,
    port: Number(process.env.IMAP_PORT || 993),
    secure: process.env.IMAP_TLS !== 'false',
    auth: { user, pass },
    logger: false,
  });

  const tenantIndex = await loadTenantByReceiverIndex();
  const mailbox = process.env.IMAP_MAILBOX || 'INBOX';

  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      // Solo los NO leídos, para no reprocesar todo el buzón cada vez.
      const uids = await client.search({ seen: false }, { uid: true });
      for (const uid of (uids || [])) {
        summary.scanned++;
        try {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) { summary.skipped++; continue; }
          const parsed = await simpleParser(msg.source as Buffer);

          // Adjuntos XML + cuerpo que sea XML directo.
          const xmls: string[] = [];
          for (const att of (parsed.attachments || [])) {
            const name = (att.filename || '').toLowerCase();
            const isXml = name.endsWith('.xml') || att.contentType === 'text/xml' || att.contentType === 'application/xml';
            if (isXml && att.content) xmls.push(att.content.toString('utf8'));
          }
          if (xmls.length === 0 && parsed.text && parsed.text.includes('<FacturaElectronica')) {
            xmls.push(parsed.text);
          }

          const emailFrom = parsed.from?.text || '';
          let anyRelevant = false;
          for (const xml of xmls) {
            const r = await processXml(xml, emailFrom, tenantIndex);
            if (r === 'ok') { summary.processed++; anyRelevant = true; }
            else if (r === 'dup') { summary.duplicates++; anyRelevant = true; }
            else if (r === 'no-tenant') { summary.noTenant++; anyRelevant = true; }
            else if (r === 'error') summary.errors++;
            else summary.skipped++;
          }
          // Marcar como leído solo si el correo tenía algún comprobante relevante
          // (así los correos sin XML se quedan sin leer por si hay que revisarlos).
          if (anyRelevant) {
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          }
        } catch (e: any) {
          summary.errors++;
          console.warn('[recepción] error procesando correo:', e?.message);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return summary;
}
