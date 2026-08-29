// Construye el payload de comprobante electrónico para Alanube (Costa Rica / CRI)
// a partir de los datos del comprobante (emisor, factura, líneas,
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
  /** Venta por plataforma de delivery: el dinero lo recauda un tercero. */
  is_delivery?: boolean;
  issued_at?: string;
}

// Hacienda MedioPago: 01 efectivo, 02 tarjeta, 03 cheque, 04 transf, 06 SINPE.
const MEDIO_PAGO: Record<string, string> = {
  cash: '01', card: '02', check: '03', transfer: '04', deposit: '04',
  third_party: '05', sinpe: '06', sinpe_movil: '06', digital: '07',
  other: '99', credit: '02', mixed: '01',
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
// Redondeo a 5 decimales (precisión que valida Alanube). NO redondear el IVA a 2
// decimales: Alanube exige `amount == taxableBase × fee` EXACTO (ej. 10619.47 ×
// 13% = 1380.5311, no 1380.53) y `amountTotalLine == amountTotal + taxNet`.
const r5 = (n: number) => Math.round(Number(n || 0) * 1e5) / 1e5;
// Alanube CRI espera los montos como STRING con EXACTAMENTE 5 decimales
// (patrón `^[0-9]{1,13}(\.[0-9]{5})?$`).
const money = (n: number) => r5(n).toFixed(5);
const qty = (n: number) => Number(n || 0).toFixed(3);   // cantidad: 3 decimales
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

/**
 * Formas conocidas del bloque de descuento por línea en Alanube CRI.
 *
 * Hacienda 4.4 lo llama `Descuento` con `MontoDescuento` + `NaturalezaDescuento`;
 * Alanube lo traduce a camelCase, y el nombre exacto cambia entre versiones de
 * su API. Se prueban en orden hasta que el documento pase.
 */
export const DISCOUNT_SHAPES: Array<(amount: string, nature: string) => Record<string, any>> = [
  // Forma CONFIRMADA por Alanube (rechazo del 22/08/2026): el ítem pide
  // `amountDiscount`, `discountCode` y `otherDiscountCode`, los tres presentes.
  // discountCode '01' = bonificación en el catálogo de Hacienda 4.4.
  (amount, nature) => ({ discounts: [{ amountDiscount: amount, discountCode: '01', otherDiscountCode: nature }] }),
  // Si '01' no fuera el código de bonificación en el catálogo del emisor, se
  // reintenta con '99' (otros) y el detalle en otherDiscountCode.
  (amount, nature) => ({ discounts: [{ amountDiscount: amount, discountCode: '99', otherDiscountCode: nature }] }),
  // Formas de versiones anteriores de la API, por si algún emisor sigue en ellas.
  (amount, nature) => ({ discounts: [{ amount, nature }] }),
  (amount, nature) => ({ discount: [{ discountAmount: amount, discountNature: nature }] }),
];

/** ¿El error de Alanube se queja del bloque de descuento? Entonces vale reintentar. */
export function isDiscountShapeError(msg: string): boolean {
  const m = String(msg ?? '').toLowerCase();
  return /discount|descuento|nature|naturaleza/.test(m);
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
    senderId?: string;          // id de la empresa emisora en Alanube (sender.id).
                                // Sin esto, Alanube emite con la empresa 'main' de la cuenta.
    /**
     * Nombre de los campos de descuento por línea en Alanube. La API los expone
     * con distinto naming según la versión, y adivinar mal cuesta un rechazo:
     * el emisor prueba las formas en orden hasta que una pasa (ver
     * `DISCOUNT_SHAPES`) y guarda la que funcionó.
     */
    discountShape?: number;
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
  /**
   * Medio de pago ante Hacienda.
   *
   * En una venta por DELIVERY el cliente le paga a la plataforma y la
   * plataforma le deposita al negocio: el código correcto es el 05, «recaudado
   * por terceros». Declararlo como efectivo —lo que salía por defecto— dice que
   * entró plata a la caja que nunca entró, y no cuadra con el depósito de la
   * plataforma cuando Hacienda cruza la información.
   */
  const medioPago = inv.is_delivery
    ? '05'
    : (MEDIO_PAGO[inv.payment_method ?? 'cash'] ?? '01');

  // Acumuladores del RESUMEN, separando MERCANCÍA vs SERVICIO. Hacienda clasifica
  // cada línea por su CABYS (no por la unidad): el primer dígito 0-4 = mercancía,
  // 5-9 = servicio (construcciones y servicios en la clasificación CPC/CABYS).
  let totalServicesTaxable = 0, totalExemptServices = 0;
  let totalTaxedGoods = 0, totalExemptGoods = 0;
  let totalTax = 0, totalSale = 0, totalDiscounts = 0;
  // Desglose de impuesto por código de tarifa (TotalDesgloseImpuesto).
  const taxByRate: Record<string, number> = {};

  // Enfoque PRECIO EFECTIVO: el descuento se absorbe en el
  // precio unitario, así amountTotal == subTotal y no hay que declarar descuento.
  // Evita todas las validaciones de "subTotal = amountTotal - descuentos".
  // Hacienda/Alanube rechazan la línea con precio 0 ("Unit price must be greater
  // than zero"). Pasa con productos creados desde una recepción de compra sin
  // precio de venta, y con REGALÍAS (lo que se da sin cobrar).
  //
  // Se sacan del comprobante y el resto queda intacto: el cliente pagó ₡X y el
  // documento declara ₡X. La regalía no es una venta — su costo se maneja como
  // gasto/autoconsumo, no como línea vendida en ₡0.
  //
  // La otra vía de Hacienda (línea con precio real + descuento de naturaleza
  // "Bonificación") necesita el bloque de descuento por línea de Alanube, que
  // este emisor todavía no arma: ver el comentario del enfoque PRECIO EFECTIVO.
  const efectivo = (l: FELine) => {
    const cantidad = Number(l.quantity) || 0;
    const neto = Number(l.subtotal ?? 0);
    return cantidad > 0 ? neto / cantidad : neto;
  };
  // REGALÍA (bonificación): el cliente no paga la línea, pero el producto TIENE
  // precio de lista. Se declara con su precio y un descuento por el 100% de
  // naturaleza "Bonificación", que es la forma que pide Hacienda: así la salida
  // de inventario queda sustentada en el comprobante.
  const isBonus = (l: FELine) => efectivo(l) <= 0 && Number(l.unit_price) > 0;
  // Sin precio de lista no hay nada que declarar: esas sí se sacan.
  const priced = lines.filter(l => efectivo(l) > 0 || isBonus(l));
  const dropped = lines.filter(l => !priced.includes(l));
  if (dropped.length) {
    console.warn('[alanube] líneas sin precio excluidas del comprobante:',
      dropped.map(l => l.product_name).join(', '));
  }
  if (priced.length === 0) {
    throw new Error(
      'Ninguna línea tiene precio: no se puede emitir un comprobante en ¢0. '
      + 'Poneles precio de venta a los productos'
      + (lines.length ? `: ${[...new Set(lines.map(l => l.product_name))].join(', ')}` : '') + '.',
    );
  }

  const shape = DISCOUNT_SHAPES[opts.discountShape ?? 0] ?? DISCOUNT_SHAPES[0];

  const itemDetails = priced.map((l) => {
    const cantidad = Number(l.quantity);
    const bonus = isBonus(l);
    // Hacienda valida el impuesto de la línea contra el MONTO TOTAL (antes del
    // descuento), no contra la base: con 13% sobre una regalía al 100% pedía
    // ₡1.345,50 de IVA que el cliente no pagó (rechazo -45). La regalía se
    // declara EXENTA: el monto queda en el comprobante, el IVA en cero, y el
    // total del documento sigue siendo lo que el cliente pagó.
    const tarifaLinea = bonus ? 0 : Number(l.iva_rate ?? 0);
    const tarifa = tarifaLinea;
    const neto = bonus ? r2(Number(l.unit_price) * cantidad) : r2(l.subtotal);
    // Precio unitario a 5 decimales = EXACTAMENTE el que enviamos en unitPrice.
    // En la regalía es el precio de lista: el descuento va aparte.
    const precioEfectivo = r5(cantidad > 0 ? neto / cantidad : neto);
    // amountTotal DEBE ser precioEfectivo × cantidad (así lo recalcula Alanube).
    // Se deriva del MISMO precio ya redondeado para que cuadre a 5 decimales y no
    // aparezca el "5198.03 != 5198.03001".
    const montoTotal = r5(precioEfectivo * cantidad);
    // Bonificación: se descuenta el 100%, así que la base gravable y el IVA de la
    // línea quedan en cero y el cliente no paga nada por ella.
    const descuento = bonus ? montoTotal : 0;
    const base = r5(montoTotal - descuento);
    // IVA y total de línea a PRECISIÓN PLENA (5 dec), sin redondear a 2: así
    // cuadran las validaciones exactas de Alanube (amount = base × fee, etc.).
    const impuesto = r5(base * (tarifa / 100));
    const lineTotal = r5(base + impuesto);

    const cabys = String(l.cabys_code ?? '').replace(/\D/g, '');
    const esServicio = cabys.length > 0 && cabys[0] >= '5';   // CABYS 5-9 = servicio
    // Código de tarifa de la línea. Para 0% es '10' (Exenta) — el MISMO que va en
    // `taxes` del ítem; tienen que coincidir o Alanube rechaza (ver abajo).
    const feeCode = tarifa > 0 ? rateCode(tarifa) : '10';
    if (tarifa > 0) {
      if (esServicio) totalServicesTaxable += montoTotal; else totalTaxedGoods += montoTotal;
    } else {
      if (esServicio) totalExemptServices += montoTotal; else totalExemptGoods += montoTotal;
    }
    // El desglose acumula TODOS los códigos de tarifa presentes en las líneas,
    // INCLUIDO el exento (10) con monto 0. Alanube valida que cada par
    // (code, feeCode) que aparece en las líneas exista en totalTaxBreakdown:
    // omitir el 10 daba "The total tax breakdown missing code: 01 with fee code 10".
    taxByRate[feeCode] = (taxByRate[feeCode] ?? 0) + impuesto;
    totalTax += impuesto;
    totalSale += montoTotal;
    totalDiscounts += descuento;

    const item: Record<string, any> = {
      code: cabys,                                            // CABYS
      quantity: qty(cantidad),
      // Unidad de medida del catálogo Hacienda (la clasificación mercancía/servicio
      // del RESUMEN la hacemos arriba por el CABYS).
      unitMeasurement: haciendaUnit(l.unit),
      detail: l.product_name,
      unitPrice: precioEfectivo.toFixed(5),                  // 5 decimales para cuadrar el total
      amountTotal: money(montoTotal),
      subTotal: money(base),
      taxableBase: money(base),
      taxNet: money(impuesto),
      amountTotalLine: money(lineTotal),
      // taxes: code=01 (IVA), feeCode=código de tarifa Hacienda (08=13%, 10=Exenta).
      // Para líneas con IVA 0% usamos el código EXENTA (10), NO "Tarifa 0%" (01):
      // con "01" Hacienda las clasifica como "No Sujetas" y el resumen (que las
      // suma como Exentas) no cuadra → rechazo -481/-485/-107.
      taxes: [{ code: '01', feeCode, fee: Number(tarifa).toFixed(2), amount: money(impuesto) }],
    };
    if (bonus) Object.assign(item, shape(money(descuento), 'Bonificacion'));
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
    totals: buildTotals(),
  };

  // sender.id → indica EXPLÍCITAMENTE con qué empresa emitir (confirmado en el
  // ejemplo oficial de createInvoice). Sin esto, Alanube usa la empresa 'main' de
  // la cuenta, que puede NO ser la del tenant.
  // sender: SOLO el id de la empresa en Alanube. Su esquema NO admite más campos
  // (probado: "Additional properties not allowed: identificationNumber, name…").
  // La cédula, el nombre y el certificado con que sale el comprobante son los que
  // tenga cargada ESA empresa en Alanube — no se pueden mandar por documento.
  if (opts.senderId) payload.sender = { id: String(opts.senderId) };

  // Resumen de la factura. Hacienda EXIGE el desglose completo (servicios/mercancías
  // gravados, total gravado, total impuesto y TotalDesgloseImpuesto) cuando hay
  // líneas gravadas; solo incluimos los campos con monto > 0 para no confundir.
  function buildTotals(): Record<string, any> {
    const t: Record<string, any> = {};
    if (totalServicesTaxable > 0) t.totalServicesTaxable = money(totalServicesTaxable);
    if (totalExemptServices > 0) t.totalExemptServices = money(totalExemptServices);
    if (totalTaxedGoods > 0) t.totalTaxedGoods = money(totalTaxedGoods);
    if (totalExemptGoods > 0) t.totalExemptGoods = money(totalExemptGoods);
    const totalTaxable = totalServicesTaxable + totalTaxedGoods;   // total gravado
    if (totalTaxable > 0) t.totalTaxable = money(totalTaxable);
    const totalExempt = totalExemptServices + totalExemptGoods;
    if (totalExempt > 0) t.totalExempt = money(totalExempt);
    t.totalSale = money(totalSale);                 // suma de líneas sin IVA (bruto)
    // Con bonificaciones, venta neta = venta − descuentos. Sin ellas es lo mismo
    // que antes, así que las facturas normales no cambian de forma.
    if (totalDiscounts > 0) t.totalDiscounts = money(totalDiscounts);
    t.totalNetSale = money(totalSale - totalDiscounts);
    if (totalTax > 0) t.totalTax = money(totalTax);   // total impuesto
    // TotalDesgloseImpuesto: un renglón por CADA código de tarifa presente en las
    // líneas — incluido el exento (10) en 0. Va aunque totalTax sea 0 (comprobante
    // 100% exento): Alanube exige que todo (code, feeCode) de las líneas esté acá.
    if (Object.keys(taxByRate).length > 0) {
      t.totalTaxBreakdown = Object.entries(taxByRate).map(([feeCode, amt]) => ({
        code: '01', feeCode, totalTaxAmount: money(amt),
      }));
    }
    t.totalVoucher = money(totalSale - totalDiscounts + totalTax);   // total del comprobante (con IVA)
    return t;
  }

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
    // La dirección del receptor es OPCIONAL en Hacienda. Solo la enviamos si la
    // ubicación está COMPLETA (provincia + cantón + distrito). Una dirección
    // parcial (ej. solo provincia) genera la observación -37 de Hacienda.
    const prov = prov1(receptor.province_code);
    const cant = pad2(receptor.canton_code);
    const dist = pad2(receptor.district_code);
    if (prov && cant && dist) {
      // Hacienda exige `otrasSenas` con AL MENOS 5 caracteres cuando se envía la
      // dirección; si el cliente no tiene detalle, se usa un valor por defecto.
      const otras = String(receptor.address ?? '').trim();
      rec.address = {
        province: prov, canton: cant, district: dist,
        otrasSenas: otras.length >= 5 ? otras : 'Sin otras señas',
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
