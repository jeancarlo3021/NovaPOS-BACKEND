/**
 * Lectura del XML de un comprobante electrónico de Hacienda.
 *
 * Vive aparte del lector de correo A PROPÓSITO. Estaba dentro del módulo que
 * abre el buzón IMAP, así que cualquier ruta que solo quisiera interpretar un
 * XML —la de facturación, por ejemplo— cargaba de paso el cliente de correo y
 * el parser de mensajes: casi 300 ms en cada arranque en frío del servidor,
 * pagados por peticiones que nunca tocan el correo.
 */
import { XMLParser } from 'fast-xml-parser';

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

export const num = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const str = (v: any): string => (v == null ? '' : String(v)).trim();

// ── Parseo del XML de Hacienda ───────────────────────────────────────────────
// Devuelve null si el XML no es un comprobante electrónico (ej. es la respuesta
// "MensajeHacienda" de aceptación, que no nos interesa recepcionar).
export function parseHaciendaXml(xml: string): ParsedDoc | null {
  // parseTagValue:false → NO convertir valores a número. La Clave (50 dígitos) y el
  // consecutivo (20) son números enteros gigantes: con parseTagValue:true JS los
  // convertía a float (5.06e+49), perdiendo precisión, y TODAS las claves del mismo
  // emisor/fecha colapsaban al mismo valor → chocaban como duplicado y no se
  // guardaban. Los montos igual se leen con num() sobre el string.
  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });
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
