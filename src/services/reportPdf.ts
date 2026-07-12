import PDFDocument from 'pdfkit';

export interface ReportSection { heading?: string; rows: Array<[string, string]>; }

/** Genera un PDF con apariencia de TICKET de cierre y lo devuelve en base64. */
export function reportPdfBase64(
  title: string, subtitle: string, sections: ReportSection[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Ancho tipo ticket (~80mm ≈ 226pt). La altura pagina sola si es largo.
    const W = 240;
    const M = 14;
    const inner = W - M * 2;
    const doc = new PDFDocument({ size: [W, 800], margins: { top: M, left: M, right: M, bottom: M } });
    const chunks: Buffer[] = [];
    doc.on('data', (d) => chunks.push(d as Buffer));
    doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    doc.on('error', reject);

    const line = (y?: number, weight = 1) => {
      const yy = y ?? doc.y;
      doc.lineWidth(weight).moveTo(M, yy).lineTo(W - M, yy).stroke();
    };

    // Título con marco
    doc.font('Courier-Bold').fontSize(15);
    doc.moveDown(0.2);
    const tY = doc.y;
    line(tY, 2);
    doc.text(title.toUpperCase(), M, tY + 4, { width: inner, align: 'center', characterSpacing: 1 });
    line(doc.y + 2, 2);
    doc.moveDown(0.4);

    if (subtitle) {
      doc.font('Courier').fontSize(9).text(subtitle, M, doc.y, { width: inner, align: 'center' });
      doc.moveDown(0.4);
    }

    for (const s of sections) {
      if (s.heading) {
        doc.moveDown(0.3);
        const hY = doc.y;
        line(hY, 1.5);
        doc.font('Courier-Bold').fontSize(10).text(s.heading.toUpperCase(), M, hY + 3, { width: inner, align: 'center', characterSpacing: 0.5 });
        line(doc.y + 2, 1.5);
        doc.moveDown(0.3);
      }
      doc.font('Courier').fontSize(10);
      for (const [a, b] of s.rows) {
        const y = doc.y;
        doc.font('Courier').text(a, M, y, { width: inner * 0.6, align: 'left' });
        doc.font('Courier-Bold').text(b, M + inner * 0.4, y, { width: inner * 0.6, align: 'right' });
        doc.moveDown(0.15);
      }
    }

    doc.moveDown(0.6);
    doc.font('Courier').fontSize(8).fillColor('#666')
      .text('Generado automáticamente por ColónClick', M, doc.y, { width: inner, align: 'center' });

    doc.end();
  });
}
