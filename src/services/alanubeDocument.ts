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

function fechaCR(issuedAt?: string): string {
  let d = issuedAt ? new Date(issuedAt) : new Date();
  if (isNaN(d.getTime()) || d.getTime() > Date.now()) d = new Date();
  return new Date(d.getTime() - 6 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '-06:00');
}

export function buildAlanubeDocument(
  emisor: AlanubeEmisor,
  inv: AlanubeInvoiceMeta,
  lines: FELine[],
  receptor: AlanubeReceptor | null,
  opts: {
    tipoDoc: string;            // '01' factura · '04' tiquete
    headquarters?: string;      // sucursal
    terminal?: string;
    numberOfDocument?: string;  // consecutivo interno
  },
) {
  const condicionVenta = inv.payment_method === 'credit' ? '02' : '01';
  const medioPago = MEDIO_PAGO[inv.payment_method ?? 'cash'] ?? '01';

  let totalTaxedGoods = 0, totalExemptGoods = 0, totalDiscounts = 0, totalTax = 0, totalSale = 0;

  const itemDetails = lines.map((l) => {
    const tarifa = Number(l.iva_rate ?? 0);
    const cantidad = Number(l.quantity);
    const precio = r2(l.unit_price);
    const bruto = r2(precio * cantidad);            // monto total (sin descuento)
    const neto = r2(l.subtotal);                    // subtotal (con descuento, sin IVA)
    const descuento = r2(Math.max(0, bruto - neto));
    const impuesto = r2(neto * (tarifa / 100));
    const lineTotal = r2(neto + impuesto);

    if (tarifa > 0) totalTaxedGoods += neto; else totalExemptGoods += neto;
    totalDiscounts += descuento;
    totalTax += impuesto;
    totalSale += bruto;

    const item: Record<string, any> = {
      code: String(l.cabys_code ?? '').replace(/\D/g, ''),   // CABYS
      quantity: String(cantidad),
      unitMeasurement: haciendaUnit(l.unit),
      detail: l.product_name,
      unitPrice: money(precio),
      amountTotal: money(bruto),
      subTotal: money(neto),
      taxableBase: money(neto),
      taxNet: money(impuesto),
      amountTotalLine: money(lineTotal),
      taxes: [{ code: '01', feeCode: rateCode(tarifa), fee: String(tarifa), amount: money(impuesto) }],
    };
    if (l.sku) item.commercialCode = [{ typeCode: '04', code: String(l.sku) }];
    return item;
  });

  const saleCondition: Record<string, any> = { id: condicionVenta };
  if (condicionVenta === '02') saleCondition.creditTerm = '30';

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
      totalDiscounts: money(totalDiscounts),
      totalNetSale: money(totalSale - totalDiscounts),
      totalTax: money(totalTax),
      totalVoucher: money(totalSale - totalDiscounts + totalTax),
    },
  };

  // Receptor: obligatorio para factura (01); opcional en tiquete (04).
  if (receptor && (receptor.identification || receptor.name)) {
    const rec: Record<string, any> = { name: receptor.name ?? '' };
    if (receptor.identification_type && receptor.identification) {
      rec.identificationType = receptor.identification_type;
      rec.identificationNumber = String(receptor.identification).replace(/\D/g, '');
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

  return payload;
}
