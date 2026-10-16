import fs from 'node:fs';
import path from 'node:path';

/**
 * LA TIPOGRAFÍA DE LOS PDF, con el símbolo del colón.
 *
 * `pdfkit` trae las 14 fuentes estándar del PDF (Courier, Helvetica…), que están
 * codificadas en WinAnsi. El **colón (₡, U+20A1) no existe en WinAnsi**: pdfkit
 * no falla, lo sustituye, y en el PDF salía «¡11 300» en vez de «₡11 300». En un
 * comprobante de Costa Rica eso no es un detalle estético —es el signo de la
 * moneda en la que se cobró—.
 *
 * Se embebe Liberation Mono (OFL 1.1), que tiene el colón y las tildes.
 * Monoespaciada a propósito: estos PDF imitan un tiquete y las columnas de
 * importes tienen que quedar alineadas.
 *
 * Si los archivos no aparecen, se cae a Courier y el PDF SALE IGUAL, sin colón.
 * Un comprobante que no se genera es peor que uno con el símbolo feo.
 */
export const FUENTE = { normal: 'mono', negrita: 'mono-bold' } as const;

/**
 * Dónde buscar cada archivo.
 *
 * Primero junto al código (`__dirname` es `src/services`), que es lo que vale
 * cuando el servidor corre las fuentes directamente; después desde la raíz del
 * proyecto, por si algún día se ejecuta compilado y con otro directorio de
 * trabajo. Se usa `__dirname` y no `import.meta.url` porque este proyecto
 * compila a CommonJS.
 */
function rutaDe(archivo: string): string | null {
  const candidatas = [
    path.join(__dirname, '..', 'assets', 'fonts', archivo),
    path.join(process.cwd(), 'src', 'assets', 'fonts', archivo),
    path.join(process.cwd(), 'assets', 'fonts', archivo),
  ];
  for (const p of candidatas) {
    try { if (fs.existsSync(p)) return p; } catch { /* sigue */ }
  }
  return null;
}

let avisado = false;

/**
 * Registra las fuentes en el documento y devuelve los nombres a usar.
 *
 * Devuelve SIEMPRE nombres válidos: con las tipografías embebidas si están, o
 * los de Courier si no.
 */
export function registrarFuentes(doc: any): { normal: string; negrita: string; conColon: boolean } {
  const reg = rutaDe('LiberationMono-Regular.ttf');
  const bold = rutaDe('LiberationMono-Bold.ttf');
  if (!reg || !bold) {
    if (!avisado) {
      avisado = true;
      console.warn('[pdf] no se encontraron las tipografías embebidas: los PDF salen sin el símbolo ₡');
    }
    return { normal: 'Courier', negrita: 'Courier-Bold', conColon: false };
  }
  try {
    doc.registerFont(FUENTE.normal, reg);
    doc.registerFont(FUENTE.negrita, bold);
    return { normal: FUENTE.normal, negrita: FUENTE.negrita, conColon: true };
  } catch (e: any) {
    console.warn('[pdf] no se pudieron registrar las tipografías:', e?.message);
    return { normal: 'Courier', negrita: 'Courier-Bold', conColon: false };
  }
}
