// Construye el payload de comprobante electrónico para Alanube (Costa Rica / CRI)
// a partir de los mismos datos que usa Facturemos (emisor, factura, líneas,
// receptor). Estructura top-level confirmada de la doc CRI:
//   currency, header, sender, receiver, itemDetails, otherCharges, totals.
//
// ⚠️ Los nombres de campos ANIDADOS son best-guess según el estándar Hacienda
// v4.4 + convenciones Alanube; se afinan contra la validación del sandbox (que
// devuelve el nombre exacto). Ajustar SOLO en este archivo.

import { haciendaUnit, type FELine } from './feDocument.js';

export interface AlanubeEmisor {
  identification_type?: string;
  identification?: string;
  name?: string;
  commercial_name?: string;
  economic_activity_code?: string;
}

export interface AlanubeReceptor {
  name?: string;
  identification_type?: string;
  identification?: string;
  email?: string;
  province_code?: string;
  canton_code?: string;
  district_code?: string;
  address?: string;
}

export interface AlanubeInvoiceMeta {
  payment_method?: string;   // cash|card|sinpe|credit|...
  issued_at?: string;
}

// Hacienda MedioPago: 01 efectivo, 02 tarjeta, 03 cheque, 04 transf, 06 SINPE.
const MEDIO_PAGO: Record<string, string> = {
  cash: '01', card: '02', check: '03', transfer: '04', deposit: '04',
  sinpe: '06', sinpe_movil: '06', credit: '02', mixed: '01',
};

// Tarifa IVA → CodigoTarifa Hacienda (08 = 13%, 01 = 0%/exento, 04 = 1%…).
function rateCode(tarifa: number): string {
  switch (tarifa) {
    case 0: return '01';
    case 1: return '02';
    case 2: return '03';
    case 4: return '04';
    case 13: return '08';
    default: return '08';
  }
}

const r2 = (n: number) => Math.round(Number(n || 0) * 100) / 100;
// Alanube CRI espera los montos como STRING numérico.
const money = (n: number) => r2(n).toFixed(2);
const padN = (s: any, n: number) => String(s ?? '').replace(/\D/g, '').padStart(n, '0').slice(-n);
const prov1 = (s: any) => (String(s ?? '').replace(/\D/g, '').replace(/^0+/, '') || '').slice(0, 1);
const pad2 = (s: any) => { const d = String(s ?? '').replace(/\D/g, ''); return d ? d.padStart(2, '0').slice(-2) : ''; };

function fechaCR(_issuedAt?: string): string {
  // Siempre la hora ACTUAL del servidor (UTC), representada en zona Costa Rica
  // (-06:00, sin horario de verano). Ignoramos el issued_at de la factura porque
  // llegaba desfasado ~6 h; la fecha de emisión debe ser el momento real de emitir.
  const nowUtc = Date.now();
  const cr = new Date(nowUtc - 6 * 60 * 60 * 1000);   // reloj de pared de Costa Rica
  return cr.toISOString().replace(/\.\d{3}Z$/, '-06:00');
}

export function buildAlanubeDocument(
  emisor: AlanubeEmisor,
  inv: AlanubeInvoiceMeta,
  lines: FELine[],
  receptor: AlanubeReceptor | null,
  opts: {
    tipoDoc: string;            // '01' factura · '04' tiquete · '03' nota de crédito
    headquarters?: string;      // sucursal
    terminal?: string;
    numberOfDocument?: string;  // consecutivo interno
    // Para nota de crédito (03): referencia al documento que anula.
    reference?: {
      documentType: string;     // tipo del doc original (01/04)
      number: string;           // clave (50 díg) del doc original
      date: string;             // fecha de emisión del original (ISO)
      code?: string;            // código de referencia (01 = anula)
      reason?: string;          // razón
    };
  },
) {
  const condicionVenta = inv.payment_method === 'credit' ? '02' : '01';
  const medioPago = MEDIO_PAGO[inv.payment_method ?? 'cash'] ?? '01';

  let totalTaxedGoods = 0, totalExemptGoods = 0, totalTax = 0, totalSale = 0;

  // Enfoque PRECIO EFECTIVO (igual que Facturemos): el descuento se absorbe en el
  // precio unitario, así amountTotal == subTotal y no hay que declarar descuento.
  // Evita todas las validaciones de "subTotal = amountTotal - descuentos".
  const itemDetails = lines.map((l) => {
    const tarifa = Number(l.iva_rate ?? 0);
    const cantidad = Number(l.quantity);
    const neto = r2(l.subtotal);                             // subtotal (con descuento, sin IVA)
    const precioEfectivo = cantidad > 0 ? neto / cantidad : neto;  // precio unitario neto
    const montoTotal = r2(precioEfectivo * cantidad);        // == neto (por redondeo)
    const impuesto = r2(montoTotal * (tarifa / 100));
    const lineTotal = r2(montoTotal + impuesto);

    if (tarifa > 0) totalTaxedGoods += montoTotal; else totalExemptGoods += montoTotal;
    totalTax += impuesto;
    totalSale += montoTotal;

    const item: Record<string, any> = {
      code: String(l.cabys_code ?? '').replace(/\D/g, ''),   // CABYS
      quantity: String(cantidad),
      unitMeasurement: haciendaUnit(l.unit),
      detail: l.product_name,
      unitPrice: precioEfectivo.toFixed(5),                  // 5 decimales para cuadrar el total
      amountTotal: money(montoTotal),
      subTotal: money(montoTotal),
      taxableBase: money(montoTotal),
      taxNet: money(impuesto),
      amountTotalLine: money(lineTotal),
      taxes: [{ code: '01', feeCode: rateCode(tarifa), fee: String(tarifa), amount: money(impuesto) }],
    };
    if (l.sku) item.commercialCode = [{ typeCode: '04', code: String(l.sku) }];
    return item;
  });

  const saleCondition: Record<string, any> = { id: condicionVenta };
  if (condicionVenta === '02') saleCondition.creditTerm = '30';

  // NOTA: la emisión de factura/tiquete ya fue ACEPTADA por Alanube con ESTA
  // estructura exacta (sin `currency` — default CRC; con `senderEconomicActivity`
  // dentro de header). NO agregar `currency`/`sender` top-level sin confirmarlo
  // contra el sandbox: el validador CRI rechaza propiedades desconocidas.
  const payload: Record<string, any> = {
    header: {
      issueDate: fechaCR(inv.issued_at),
      idDoc: {
        headquarters: padN(opts.headquarters ?? '1', 3),
        terminal: padN(opts.terminal ?? '1', 5),
        numberOfDocument: padN(opts.numberOfDocument ?? '1', 10),
      },
      saleCondition,
      paymentMethod: [{ id: medioPago }],
      senderEconomicActivity: String(emisor.economic_activity_code ?? '').trim(),
    },
    itemDetails,
    totals: {
      totalExemptServices: money(0),
      totalTaxedGoods: money(totalTaxedGoods),
      totalExemptGoods: money(totalExemptGoods),
      totalExempt: money(totalExemptGoods),
      totalSale: money(totalSale),
      totalDiscounts: money(0),
      totalNetSale: money(totalSale),
      totalTax: money(totalTax),
      totalVoucher: money(totalSale + totalTax),
    },
  };

  // Receptor: obligatorio para factura (01); opcional en tiquete (04).
  if (receptor && (receptor.identification || receptor.name)) {
    const rec: Record<string, any> = { name: receptor.name ?? '' };
    if (receptor.identification_type && receptor.identification) {
      // Alanube CRI exige la identificación ANIDADA en
      // `identification: { identificationType, identificationNumber }`.
      rec.identification = {
        identificationType: receptor.identification_type,
        identificationNumber: String(receptor.identification).replace(/\D/g, ''),
      };
    }
    if (receptor.email) rec.email = receptor.email;
    if (receptor.province_code) {
      rec.address = {
        province: prov1(receptor.province_code),
        canton: pad2(receptor.canton_code),
        district: pad2(receptor.district_code),
        otrasSenas: receptor.address ?? '',
      };
    }
    payload.receiver = rec;
  }

  // Nota de crédito (03): bloque de referencia al documento original.
  if (opts.reference) {
    payload.referenceDocuments = [{
      typeDoc: opts.reference.documentType,
      number: opts.reference.number,
      dateEmission: opts.reference.date ? fechaCR(opts.reference.date) : fechaCR(),
      code: opts.reference.code ?? '01',
      reason: opts.reference.reason ?? 'Anulación de documento',
    }];
  }

  return payload;
}
