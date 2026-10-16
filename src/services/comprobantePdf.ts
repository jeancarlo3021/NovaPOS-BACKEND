import type { DatosCorreoComprobante } from './comprobanteEmail.js';
import { tipoDeClave, consecutivoDeClave } from './comprobanteEmail.js';
import { registrarFuentes } from './pdfFont.js';

/**
 * EL PDF DEL COMPROBANTE, hecho por nosotros.
 *
 * El PDF que adjuntábamos lo generaba Alanube, y su plantilla no tiene dónde
 * mostrar la NOTA de la factura: el «entrega el jueves» o la orden de compra que
 * el negocio le escribe al cliente no llegaba a ninguna parte. Tampoco se podía
 * arreglar de nuestro lado, porque esa plantilla es de ellos.
 *
 * Este PDF tiene la forma del TIQUETE: el cliente ya vio ese papel en el
 * mostrador, y el correo que le llega ahora se ve igual. Mismo orden de bloques,
 * misma letra monoespaciada, mismo total entre dos rayas.
 *
 * Lleva lo que la representación impresa necesita: tipo de documento, número,
 * consecutivo de Hacienda, clave de 50 dígitos, emisor con cédula, detalle,
 * impuesto, total y la leyenda de la resolución 4.4. El comprobante con validez
 * legal sigue siendo el XML, que va adjunto en el mismo correo.
 */

/** Leyenda obligatoria al pie del comprobante electrónico (resolución DGT 4.4). */
const FE_RESOLUTION_FOOTER =
  'Autorizada mediante resolución MH-DGT-RES-0027-2024 del 13 de noviembre del 2024 de la DGTD. Version 4.4';

/** Importe como en el tiquete: sin decimales si es redondo. */
const monto = (n: any): string => {
  const v = Number(n || 0);
  const dec = Math.abs(v % 1) > 0.004 ? 2 : 0;
  return `₡${v.toLocaleString('es-CR', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
};
const cant = (n: any) => Number(n || 0).toLocaleString('es-CR', { maximumFractionDigits: 3 });

const fechaLarga = (iso?: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(String(iso).length <= 10 ? `${iso}T12:00:00` : String(iso));
  return isNaN(d.getTime()) ? null : d.toLocaleDateString('es-CR', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Costa_Rica',
  });
};

/** La clave en bloques de diez: de corrido no se puede ni dictar ni copiar. */
const claveEnBloques = (clave: string): string => {
  const d = String(clave ?? '').replace(/\D/g, '');
  return d.length === 50 ? (d.match(/.{1,10}/g) ?? [d]).join(' ') : String(clave ?? '');
};

const estadoTexto = (estado?: string | null): string =>
  estado === 'accepted' ? 'ACEPTADO POR HACIENDA'
  : estado === 'rejected' ? 'RECHAZADO POR HACIENDA'
  : 'EN PROCESO EN HACIENDA';

/** Genera el PDF del comprobante y lo devuelve en base64. */
export async function comprobantePdfBase64(d: DatosCorreoComprobante): Promise<string> {
  const { default: PDFDocument } = await import('pdfkit');

  // Ancho tipo tiquete (~80 mm ≈ 226 pt). La altura la decide el contenido: se
  // mide primero y después se crea el documento, para que no quede media hoja
  // en blanco al final ni se corte el pie en una segunda página.
  const W = 300;
  const M = 18;
  const inner = W - M * 2;

  const n = d.negocio;
  const tipo = tipoDeClave(d.clave);
  const consecutivo = consecutivoDeClave(d.clave);
  const fecha = fechaLarga(d.fecha);
  const nota = String(d.nota ?? '').trim();

  // Las líneas se muestran CON IMPUESTO, igual que el tiquete y el correo: es lo
  // que el cliente pagó, y así la suma de los renglones da el total.
  const base = Number(d.subtotal ?? 0);
  const iva = Number(d.impuesto ?? 0);
  const tasa = base > 0 && iva > 0 ? iva / base : 0;
  const conIva = (v: number) => (tasa > 0 ? Math.round(v * (1 + tasa)) : v);
  const lineas = (d.lineas ?? []).slice(0, 200);

  /**
   * SE DIBUJA DOS VECES: una para medir y otra de verdad.
   *
   * Un PDF declara el alto de la página ANTES de escribir, y acá el alto depende
   * del contenido (un comprobante de dos renglones y uno de cuarenta no miden
   * igual). Si se abre una hoja larga y después se recorta, el contenido se
   * corre: el PDF mide desde abajo, así que achicar la hoja mueve todo. La
   * primera pasada no se guarda; solo sirve para saber dónde terminó el texto.
   */
  const dibujar = (doc: any): number => {
  const F = registrarFuentes(doc);

  const centro = (txt: string, size = 9, negrita = false, espacio = 0) => {
    doc.font(negrita ? F.negrita : F.normal).fontSize(size)
      .text(txt, M, doc.y, { width: inner, align: 'center', characterSpacing: espacio });
  };
  const izquierda = (txt: string, size = 9, negrita = false) => {
    doc.font(negrita ? F.negrita : F.normal).fontSize(size)
      .text(txt, M, doc.y, { width: inner, align: 'left' });
  };
  /** Separador de guiones, como el del tiquete. */
  const sep = () => {
    doc.moveDown(0.25);
    doc.font(F.normal).fontSize(9).fillColor('#444')
      .text('-'.repeat(Math.floor(inner / 5.4)), M, doc.y, { width: inner, align: 'left' });
    doc.fillColor('#000');
    doc.moveDown(0.15);
  };

  // ── Encabezado ──
  centro(tipo.toUpperCase(), 12, true, 0.6);
  centro(`Factura #${d.numero}`, 10, true);
  if (consecutivo) centro(`Consecutivo: ${consecutivo}`, 8);
  centro(`Clave: ${claveEnBloques(d.clave)}`, 7);
  if (fecha) centro(fecha, 9);
  doc.moveDown(0.3);
  centro(estadoTexto(d.estado), 8, true, 0.4);

  // ── Emisor ──
  doc.moveDown(0.5);
  centro(n.nombre, 11, true);
  if (n.razonSocial && n.razonSocial !== n.nombre) centro(n.razonSocial, 8);
  if (n.cedula) centro(`Céd. ${n.cedula}`, 8);
  if (n.direccion) centro(n.direccion, 8);
  if (n.telefono) centro(`Tel. ${n.telefono}`, 8);
  if (n.correo) centro(n.correo, 8);

  sep();

  if (d.cliente) {
    izquierda('CLIENTE', 9, true);
    izquierda(d.cliente, 9);
    sep();
  }

  // ── Artículos: nombre e importe en la misma línea, el desglose debajo ──
  if (lineas.length > 0) {
    izquierda('ARTÍCULOS', 9, true);
    for (const l of lineas) {
      const importe = monto(conIva(l.importe));
      const anchoImporte = doc.font(F.negrita).fontSize(9).widthOfString(importe);
      const y = doc.y;
      doc.font(F.negrita).fontSize(9)
        .text(l.nombre, M, y, { width: inner - anchoImporte - 6, align: 'left' });
      const yDespues = doc.y;
      doc.font(F.negrita).fontSize(9)
        .text(importe, M + inner - anchoImporte, y, { width: anchoImporte, align: 'right' });
      doc.y = yDespues;
      doc.font(F.normal).fontSize(8)
        .text(`  ${cant(l.cantidad)} × ${monto(conIva(l.precio))}`, M, doc.y, { width: inner });
    }
    if ((d.lineas?.length ?? 0) > lineas.length) {
      izquierda(`y ${(d.lineas!.length - lineas.length)} línea(s) más`, 8);
    }
    sep();
  }

  // ── Totales ──
  if (iva > 0) {
    const txt = monto(iva);
    const ancho = doc.font(F.normal).fontSize(9).widthOfString(txt);
    const y = doc.y;
    doc.font(F.normal).fontSize(9).text('IVA incluido:', M, y, { width: inner, align: 'left' });
    doc.y = y;
    doc.font(F.normal).fontSize(9).text(txt, M + inner - ancho, y, { width: ancho, align: 'right' });
    doc.moveDown(0.2);
    sep();
  }

  doc.moveDown(0.2);
  const yTotal = doc.y;
  doc.lineWidth(1.2).moveTo(M, yTotal).lineTo(W - M, yTotal).stroke();
  doc.font(F.negrita).fontSize(14)
    .text(`*** TOTAL: ${monto(d.total)} ***`, M, yTotal + 5, { width: inner, align: 'center', characterSpacing: 0.5 });
  doc.lineWidth(1.2).moveTo(M, doc.y + 3).lineTo(W - M, doc.y + 3).stroke();
  doc.moveDown(0.6);

  if (nota) {
    sep();
    izquierda('NOTA', 9, true);
    izquierda(nota, 9);
  }

  sep();
  doc.font(F.normal).fontSize(7).fillColor('#333')
    .text(FE_RESOLUTION_FOOTER, M, doc.y, { width: inner, align: 'center' });
  doc.moveDown(0.4);
  doc.fontSize(7).fillColor('#666')
    .text('El comprobante con validez ante Hacienda es el XML adjunto.', M, doc.y, { width: inner, align: 'center' });
  doc.fillColor('#000');

    return doc.y;
  };

  // Pasada 1: medir. Hoja deliberadamente larga para que nada se parta en dos
  // páginas y la medida salga de corrido.
  const regla = new PDFDocument({ size: [W, 20000], margins: { top: M, left: M, right: M, bottom: M } });
  regla.on('error', () => { /* no se usa su salida */ });
  const alto = Math.max(160, Math.ceil(dibujar(regla) + M));
  regla.end();

  // Pasada 2: el documento de verdad, con el alto exacto.
  const doc = new PDFDocument({ size: [W, alto], margins: { top: M, left: M, right: M, bottom: M } });
  const chunks: Buffer[] = [];
  const listo = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  dibujar(doc);
  doc.end();
  return (await listo).toString('base64');
}
