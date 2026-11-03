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
import AdmZip from 'adm-zip';
import { parseHaciendaXml, str } from './haciendaXml.js';
export { parseHaciendaXml } from './haciendaXml.js';
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

// Cédula normalizada a SOLO dígitos (para comparar sin importar guiones/ceros).
const cedulaDigits = (v: any): string => str(v).replace(/\D/g, '');

// ── Mapeo receptor → tenant ──────────────────────────────────────────────────
// Busca el tenant cuya config de FE tenga `emisor_identification` == cédula del
// receptor (comparando solo dígitos). Cachea todas las configs en una query.
// SEGURIDAD: un comprobante SOLO se asigna al tenant cuya cédula coincide con la
// del RECEPTOR del XML; si ninguna coincide, no se guarda (nunca a otro negocio).
async function loadTenantByReceiverIndex(): Promise<Map<string, string>> {
  const idx = new Map<string, string>();
  const { data } = await db.from('settings').select('tenant_id, config').eq('type', 'electronic-invoice');
  for (const row of (data ?? []) as any[]) {
    const ced = cedulaDigits(row.config?.emisor_identification);
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

  const tenantId = tenantIndex.get(cedulaDigits(doc.receiver.id));
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
    // En la moneda del comprobante, no en colones: `total` queda tal cual lo
    // declaró el emisor y la conversión se hace donde se usa, con ESTE tipo de
    // cambio. Guardar ya convertido perdería el monto original, que es el que
    // el proveedor va a reclamar si hay diferencia.
    currency: doc.currency,
    exchange_rate: doc.exchangeRate,
    ack_status: 'pending',
    source: 'email',
    email_from: emailFrom,
    receiver_id: doc.receiver.id,
    xml,
    purchase_id: purchaseId,
    raw: { lines: doc.lines, receiver: doc.receiver },
  });
  if (error) {
    // Violación de índice único (tenant_id + clave): la factura ya está en la bandeja
    // (dos correos iguales o corridas del cron solapadas) → es un DUPLICADO, no un error.
    if ((error as any).code === '23505' || /duplicate key|unique/i.test(error.message)) {
      return 'dup';
    }
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
  /** Se acabó el tiempo antes de recorrer todo el buzón. */
  cortado_por_tiempo?: boolean;
  /** Correos de la ventana que quedaron sin mirar en esta corrida. */
  restantes?: number;
  /** Qué buzones se miraron y cuántos correos había en cada uno. */
  buzones?: Array<{ buzon: string; mirados: number }>;
  /** Correos que ya se habían examinado en corridas anteriores: se saltearon. */
  ya_vistos?: number;
  /**
   * DÓNDE SE FUE EL TIEMPO. Sin esto, «solo procesó 3» no se puede explicar:
   * puede ser el buzón lento para conectar, correos pesados, o poco plazo.
   */
  tiempos?: { conexion_ms: number; total_ms: number; por_correo_ms: number };
  debug?: any[];
}

/**
 * QUÉ BUZONES HAY QUE MIRAR.
 *
 * La bandeja de entrada (o las que diga `IMAP_MAILBOX`, separadas por comas)
 * y el de SPAM. El de spam se busca por la marca `\Junk` que informa el
 * propio servidor, porque su nombre cambia con el proveedor y con el idioma;
 * si no la informa, se prueban los nombres conocidos.
 *
 * Con `IMAP_SIN_SPAM=1` se deja de mirar, por si en alguna cuenta el spam es
 * enorme y se come el tiempo de la corrida.
 */
/**
 * LOS CORREOS QUE YA SE MIRARON, para no volver a bajarlos.
 *
 * Descargar un correo con un PDF adjunto es lo caro de todo este proceso. Sin
 * memoria entre corridas, cada vuelta gastaba su presupuesto bajando los
 * mismos primeros correos y el resto del buzón no se miraba NUNCA: con plazo
 * para tres, se procesaban tres veces los mismos tres.
 *
 * Si la tabla todavía no existe (migración sin correr), se sigue como antes:
 * esto es una mejora, no un requisito.
 */
async function uidsYaVistos(cuenta: string, buzon: string, uidvalidity: number | null): Promise<Set<number>> {
  try {
    const { data, error } = await db.from('recepcion_correos_vistos')
      .select('uid, uidvalidity').eq('cuenta', cuenta).eq('buzon', buzon).limit(5000);
    if (error) throw new Error(error.message);
    return new Set(((data ?? []) as any[])
      /* Si el servidor cambió la uidvalidity, los uid de ese buzón se
         reasignaron: lo anotado ya no habla de los mismos correos. */
      .filter(r => uidvalidity == null || r.uidvalidity == null || Number(r.uidvalidity) === uidvalidity)
      .map(r => Number(r.uid)));
  } catch (e: any) {
    console.warn('[recepción] no se pudo leer lo ya visto:', e?.message);
    return new Set();
  }
}

/** Anota que un correo ya se examinó. Nunca rompe la corrida. */
async function anotarVisto(cuenta: string, buzon: string, uidvalidity: number | null, uid: number, conComprobante: boolean) {
  try {
    await db.from('recepcion_correos_vistos').upsert({
      cuenta, buzon, uidvalidity, uid, con_comprobante: conComprobante,
      visto_at: new Date().toISOString(),
    }, { onConflict: 'cuenta,buzon,uid' });
  } catch (e: any) {
    console.warn('[recepción] no se pudo anotar el correo visto:', e?.message);
  }
}

export async function buzonesAMirar(client: any): Promise<string[]> {
  const pedidos = String(process.env.IMAP_MAILBOX || 'INBOX')
    .split(',').map(x => x.trim()).filter(Boolean);
  const buzones = pedidos.length > 0 ? pedidos : ['INBOX'];
  if (String(process.env.IMAP_SPAM ?? '').trim() === '0'
    || String(process.env.IMAP_SIN_SPAM ?? '').trim() === '1') return buzones;

  try {
    const carpetas: any[] = (await client.list()) || [];
    const porMarca = carpetas.find(f =>
      String(f?.specialUse ?? '') === '\\Junk'
      || (Array.isArray(f?.flags) && [...f.flags].some((x: any) => String(x) === '\\Junk')));
    const nombres = /^(spam|junk|correo no deseado|bulk mail)$/i;
    const porNombre = carpetas.find(f =>
      nombres.test(String(f?.name ?? '')) || nombres.test(String(f?.path ?? '').split(/[./]/).pop() ?? ''));
    const spam = porMarca?.path ?? porNombre?.path ?? null;
    if (spam && !buzones.includes(spam)) buzones.push(spam);
  } catch (e: any) {
    /* Si no se pueden listar las carpetas se sigue con la bandeja de entrada:
       no leer el spam es peor que hoy, pero no leer nada es mucho peor. */
    console.warn('[recepción] no se pudieron listar las carpetas:', e?.message);
  }
  return buzones;
}

// ── Entrada principal: lee el buzón y procesa ────────────────────────────────
// `debug` devuelve, por cada correo, sus adjuntos (nombre, tipo, tamaño) y si se
// detectó XML — para diagnosticar por qué un correo no entra a la bandeja.
export async function fetchAndProcessReceivedEmails(
  opts?: { debug?: boolean; presupuestoMs?: number },
): Promise<ReceiveSummary> {
  const debug = !!opts?.debug;
  /* El cronómetro arranca ACÁ, no al empezar a leer correos: conectarse al
     buzón y buscar también gastan tiempo del presupuesto, y cuando el buzón
     está lento eso es justo lo que se come la corrida. */
  const arranque = Date.now();
  const debugInfo: any[] = [];
  const summary: ReceiveSummary = { scanned: 0, processed: 0, duplicates: 0, noTenant: 0, skipped: 0, errors: 0 };

  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!host || !user || !pass) {
    throw new Error('Faltan credenciales IMAP (IMAP_HOST, IMAP_USER, IMAP_PASS).');
  }

  /**
   * EL PRESUPUESTO EMPIEZA EN LA CONEXIÓN, NO EN EL PRIMER CORREO.
   *
   * El plazo cuidaba el recorrido de los mensajes, pero conectarse al buzón
   * no tenía ninguno: con el servidor de correo lento o caído, `connect()`
   * se quedaba esperando y se llevaba puesto el trabajo entero —el cron
   * externo cortaba y ni los respaldos ni los anuncios llegaban a correr—.
   *
   * Ahora la conexión tiene tope y, si no entra, se avisa y se sigue: un
   * buzón que no contesta es un problema del buzón, no una razón para que no
   * se haga nada más.
   */
  const LIMITE_TOTAL = Math.max(4_000, opts?.presupuestoMs ?? (Number(process.env.RECEPTION_BUDGET_MS) || 22_000));
  const TOPE_CONEXION = Math.min(8_000, Math.max(3_000, Math.floor(LIMITE_TOTAL / 2)));

  const client = new ImapFlow({
    host,
    port: Number(process.env.IMAP_PORT || 993),
    secure: process.env.IMAP_TLS !== 'false',
    auth: { user, pass },
    logger: false,
    /* Los topes del propio cliente: sin esto, un socket que se queda abierto
       sin contestar espera para siempre. */
    connectionTimeout: TOPE_CONEXION,
    greetingTimeout: TOPE_CONEXION,
    socketTimeout: LIMITE_TOTAL,
  });

  const tenantIndex = await loadTenantByReceiverIndex();

  /* Y el tope de afuera, por si el cliente no respeta los suyos. */
  const antesDeConectar = Date.now();
  await Promise.race([
    client.connect(),
    new Promise((_, rechazar) => setTimeout(
      () => rechazar(new Error(`El buzón no contestó en ${Math.round(TOPE_CONEXION / 1000)} s`)), TOPE_CONEXION)),
  ]);
  const conexionMs = Date.now() - antesDeConectar;
  try {
    /**
     * TODOS LOS BUZONES, NO SOLO LA BANDEJA DE ENTRADA.
     *
     * Las facturas electrónicas llegan de remitentes que el proveedor de
     * correo no conoce, con un XML adjunto y un cuerpo casi vacío: es el
     * retrato de un correo basura, y se van a SPAM con frecuencia. Cada una
     * que cae ahí es una compra que no entra al sistema y un crédito fiscal
     * que se pierde sin que nadie lo note, porque el cron decía «0 correos»
     * con total normalidad.
     *
     * El de spam no se adivina por nombre —cambia con el idioma y el
     * proveedor: «Spam», «Junk», «[Gmail]/Spam», «Correo no deseado»—: se le
     * pregunta al servidor cuál tiene la marca \Junk, que es el dato que
     * existe justamente para esto. Si el servidor no la informa, recién ahí
     * se prueban los nombres de siempre.
     */
    let sinTiempo = false;
    for (const buzon of await buzonesAMirar(client)) {
      if (sinTiempo || Date.now() - arranque > LIMITE_TOTAL) break;
      const antes = summary.scanned;
      try {
        const lock = await client.getMailboxLock(buzon);
        try {
          // Procesamos los correos RECIENTES (leídos o no), no solo los no leídos: si
          // alguien abre el correo (ej. para verificar que llegó, o porque el proveedor
          // lo manda dos veces), quedaba marcado como leído y el cron lo saltaba PARA
          // SIEMPRE → la compra nunca cargaba. La deduplicación por clave (tenant_id +
          // clave en received_documents) evita insertar dos veces. Ventana configurable
          // con RECEPTION_DAYS (por defecto 15 días).
          const days = Math.max(1, Number(process.env.RECEPTION_DAYS || 15));
          const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
          const encontrados = (await client.search({ since }, { uid: true })) || [];
          /* Lo que ya se examinó en corridas anteriores se SALTEA sin
             descargarlo: bajar el correo es lo caro, y volver a bajarlo es la
             razón por la que cada corrida procesaba siempre los mismos. */
          const uidvalidity = Number((client as any)?.mailbox?.uidValidity ?? 0) || null;
          const vistos = await uidsYaVistos(user, buzon, uidvalidity);

          /**
           * Del MÁS NUEVO al más viejo, y con tiempo límite.
           *
           * El servidor corta la ejecución a los 30 segundos. Este proceso recorría
           * la ventana entera —quince días de correos— en cada corrida, así que al
           * crecer el buzón empezó a morir por tiempo agotado: se caía a mitad y no
           * quedaba constancia de qué había alcanzado a procesar.
           *
           * Empezar por los más nuevos hace que cada corrida procese lo que llegó
           * desde la anterior, que es lo urgente; los viejos ya se procesaron en
           * corridas pasadas y la deduplicación por clave impide duplicarlos. Con el
           * plazo, el proceso termina bien y dice cuántos quedaron sin mirar.
           */
          /* El plazo lo manda quien llama: este trabajo comparte el tiempo con
             los respaldos, los avisos y los anuncios, y un número fijo escrito
             acá no sabe nada de eso. */
          const LIMITE_MS = LIMITE_TOTAL;
          const todos = [...encontrados].reverse();
          const uids = todos.filter((u: any) => !vistos.has(Number(u)));
          summary.ya_vistos = (summary.ya_vistos ?? 0) + (todos.length - uids.length);

          for (const uid of uids) {
            if (Date.now() - arranque > LIMITE_MS) {
              summary.cortado_por_tiempo = true;
              summary.restantes = uids.length - summary.scanned;
              sinTiempo = true;
              break;
            }
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
              /* Queda anotado que ya se miró —con comprobante o sin él—, para
                 que la próxima corrida AVANCE en vez de repetir los mismos.
                 En modo prueba no: ahí se quiere poder volver a correrlo. */
              if (!debug) await anotarVisto(user, buzon, uidvalidity, Number(uid), anyRelevant);
            } catch (e: any) {
              summary.errors++;
              console.warn('[recepción] error procesando correo:', e?.message);
            }
          }
        } finally {
          lock.release();
        }
        summary.buzones = [...(summary.buzones ?? []),
          { buzon, mirados: summary.scanned - antes }];
      } catch (e: any) {
        /* Un buzón que no se puede abrir no puede dejar sin leer a los
           demás: el spam puede no existir y la bandeja de entrada sí. */
        summary.errors++;
        console.warn(`[recepción] no se pudo leer «${buzon}»:`, e?.message);
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }

  /* DÓNDE SE FUE EL TIEMPO. «Solo procesó tres» tiene tres explicaciones muy
     distintas —el buzón tardó en abrir, los correos son pesados, o el plazo
     es corto— y sin estos números no se puede saber cuál es. */
  const totalMs = Date.now() - arranque;
  summary.tiempos = {
    conexion_ms: conexionMs,
    total_ms: totalMs,
    por_correo_ms: summary.scanned > 0
      ? Math.round((totalMs - conexionMs) / summary.scanned) : 0,
  };

  if (debug) summary.debug = debugInfo;
  return summary;
}
