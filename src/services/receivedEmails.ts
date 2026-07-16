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
import AdmZip from 'adm-zip';
import { db } from '../db/client.js';

// Detecta si un texto parece un comprobante electrónico de Hacienda.
const looksLikeFE = (s: string) => /<\??\s*(FacturaElectronica|TiqueteElectronico|NotaCreditoElectronica|NotaDebitoElectronica|FacturaElectronicaCompra|FacturaElectronicaExportacion)/i.test(s);

// Saca todos los XML de comprobante que haya en un adjunto: reconoce .xml,
// application/xml, octet-stream con contenido XML, y .zip con XML adentro.
function xmlsFromAttachment(att: any): string[] {
  const out: string[] = [];
  if (!att?.content) return out;
  const name = (att.filename || '').toLowerCase();
  const ct = (att.contentType || '').toLowerCase();
  // ZIP: descomprimir y sacar los .xml de adentro.
  if (name.endsWith('.zip') || ct.includes('zip')) {
    try {
      const zip = new AdmZip(att.content as Buffer);
      for (const entry of zip.getEntries()) {
        if (entry.entryName.toLowerCase().endsWith('.xml')) {
          const txt = entry.getData().toString('utf8');
          if (looksLikeFE(txt)) out.push(txt);
        }
      }
    } catch { /* zip corrupto → se ignora */ }
    return out;
  }
  // Cualquier otro adjunto: intentar leerlo como texto y ver si es XML de Hacienda.
  const txt = (att.content as Buffer).toString('utf8');
  if (name.endsWith('.xml') || ct.includes('xml') || looksLikeFE(txt)) {
    out.push(txt);
  }
  return out;
}

// ── Tipos ────────────────────────────────────────────────────────────────────
interface ParsedLine {
  detail: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  tax: number;
  cabys: string;                // código CABYS de la línea (para actualizar el producto)
  code: string;                 // código comercial del proveedor (si trae)
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
  // Código comercial del proveedor: <CodigoComercial><Codigo>… (puede venir array).
  const commercialCode = (l: any): string => {
    const cc = l.CodigoComercial;
    if (!cc) return str(l.Codigo);
    const first = Array.isArray(cc) ? cc[0] : cc;
    return str(first?.Codigo ?? first);
  };
  const lines: ParsedLine[] = rawLines.map(l => ({
    detail: str(l.Detalle),
    quantity: num(l.Cantidad) || 1,
    unit_price: num(l.PrecioUnitario),
    subtotal: num(l.SubTotal ?? l.MontoTotal),
    tax: num(l.Impuesto?.Monto ?? (Array.isArray(l.Impuesto) ? l.Impuesto.reduce((s: number, i: any) => s + num(i.Monto), 0) : 0)),
    cabys: str(l.CodigoCABYS ?? l.Codigo?.Codigo),   // v4.3+: CodigoCABYS
    code: commercialCode(l),
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

  // El cron SOLO registra el comprobante en la bandeja. El proveedor y la orden
  // de compra se crean recién cuando el usuario confirma que es una "compra".
  const purchaseId = null;

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
  debug?: any[];
}

// ── Entrada principal: lee el buzón y procesa ────────────────────────────────
// `debug` devuelve, por cada correo, sus adjuntos (nombre, tipo, tamaño) y si se
// detectó XML — para diagnosticar por qué un correo no entra a la bandeja.
export async function fetchAndProcessReceivedEmails(opts?: { debug?: boolean }): Promise<ReceiveSummary> {
  const debug = !!opts?.debug;
  const debugInfo: any[] = [];
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

          // Adjuntos XML (incluye octet-stream, .zip) + cuerpo que sea XML directo.
          const xmls: string[] = [];
          for (const att of (parsed.attachments || [])) {
            for (const x of xmlsFromAttachment(att)) xmls.push(x);
          }
          for (const body of [parsed.text, parsed.html].filter(Boolean) as string[]) {
            if (looksLikeFE(body)) xmls.push(body);
          }

          if (debug) {
            debugInfo.push({
              subject: parsed.subject,
              from: parsed.from?.text,
              attachments: (parsed.attachments || []).map(a => ({
                filename: a.filename, contentType: a.contentType, size: a.size,
              })),
              xmlFound: xmls.length,
            });
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
          // En modo debug NO se marca, para poder re-ejecutar la prueba.
          if (anyRelevant && !debug) {
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

  if (debug) summary.debug = debugInfo;
  return summary;
}
