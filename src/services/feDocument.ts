/**
 * Constructor del documento electrónico para Facturemos (formato exacto de su API).
 *
 * Basado en el ejemplo de Facturemos:
 *  - Raíz: { "TiqueteElectronico": {...} } (o "FacturaElectronica" para factura).
 *  - Clave y NumeroConsecutivo van en "0": los asigna Facturemos.
 *  - Valores como STRING. Línea única = objeto; varias = array.
 *  - "RecalcularResumen":"1" → Facturemos recalcula el ResumenFactura.
 *
 * Fase 3: Tiquete electrónico (04). Receptor opcional ("Cliente General").
 */
import type { ConsecutivoModel } from './facturemos.js';

export interface FEEmisor {
  identification_type: string;
  identification: string;
  name: string;
  commercial_name?: string;
  province_code?: string;
  canton_code?: string;
  district_code?: string;
  address?: string;
  phone?: string;
  email?: string;
  economic_activity_code?: string;
  proveedor_sistemas?: string;   // cédula del proveedor de sistemas (Facturemos)
}

export interface FEReceptor {
  name?: string | null;
  identification_type?: string | null;
  identification?: string | null;
  email?: string | null;
  province_code?: string | null;
  canton_code?: string | null;
  district_code?: string | null;
  address?: string | null;
}

export interface FEInvoice {
  invoice_number: string;
  issued_at?: string;
  payment_method: string;          // cash|card|sinpe|credit|mixed|...
  document_type?: string;          // ticket|tiquete_electronico|factura_electronica
  total?: number;
}

export interface FELine {
  product_name: string;
  sku?: string | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
  cabys_code?: string | null;
  iva_rate?: number | null;        // % (ej. 13)
  unit?: string | null;
}

const COMPROBANTE: Record<string, string> = {
  factura_electronica: '01',
  tiquete_electronico: '04',
  ticket: '04',
};

// Hacienda MedioPago: 01 efectivo, 02 tarjeta, 03 cheque, 04 transferencia/SINPE.
const MEDIO_PAGO: Record<string, string> = {
  cash: '01', card: '02', sinpe: '04', transfer: '04', check: '03', credit: '02', mixed: '01',
};

const pad = (s: string | number, n: number) => String(s).replace(/\D/g, '').padStart(n, '0').slice(-n);
// Provincia = 1 díg (sin ceros a la izquierda: "04" → "4").
const prov1 = (s: any) => (String(s ?? '').replace(/\D/g, '').replace(/^0+/, '') || '').slice(0, 1);
// Cantón/Distrito = 2 díg ("3" → "03").
const pad2 = (s: any) => { const d = String(s ?? '').replace(/\D/g, ''); return d ? d.padStart(2, '0').slice(-2) : ''; };
const money = (n: number) => (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
const num = (n: number) => String(Math.round(Number(n || 0) * 1000) / 1000);

export function tipoComprobante(documentType?: string): string {
  return COMPROBANTE[documentType ?? 'tiquete_electronico'] ?? '04';
}

export function buildConsecutivo(
  inv: FEInvoice,
  opts: { sucursal?: string; terminal?: string; situacion?: string } = {},
): ConsecutivoModel {
  return {
    Sucursal: pad(opts.sucursal ?? '1', 3),
    Terminal: pad(opts.terminal ?? '1', 5),
    TipoComprobante: tipoComprobante(inv.document_type),
    ConsecutivoInterno: pad(inv.invoice_number, 10),
    SituacionDelComprobante: opts.situacion ?? '1',
  };
}

/** ISO-8601 con offset de Costa Rica (-06:00). */
function fechaCR(issuedAt?: string): string {
  const d = issuedAt ? new Date(issuedAt) : new Date();
  return new Date(d.getTime() - 6 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '-06:00');
}

/** Tarifa IVA → CodigoTarifaIVA de Hacienda (08 = 13%, 01 = exento/0%, 04 = 1%...). */
function codigoTarifaIVA(tarifa: number): string {
  switch (tarifa) {
    case 0: return '01';
    case 1: return '02';
    case 2: return '03';
    case 4: return '04';
    case 13: return '08';
    default: return '08';
  }
}

/**
 * Construye el JSON (string) para el campo `Factura`.
 * Usa RecalcularResumen=1 para que Facturemos calcule los totales del resumen.
 */
export function buildDocumentoJson(
  emisor: FEEmisor,
  inv: FEInvoice,
  lines: FELine[],
  receptor?: FEReceptor | null,
): string {
  const esFactura = tipoComprobante(inv.document_type) === '01';
  const condicionVenta = inv.payment_method === 'credit' ? '02' : '01';
  const medioPago = MEDIO_PAGO[inv.payment_method] ?? '01';

  const lineaDetalle = lines.map((l, i) => {
    const tarifa = Number(l.iva_rate ?? 0);
    const montoTotal = Math.round(l.unit_price * l.quantity * 100) / 100;
    const subtotal = Math.round(Number(l.subtotal ?? montoTotal) * 100) / 100;
    const impuestoMonto = Math.round(subtotal * (tarifa / 100) * 100) / 100;
    const linea: any = {
      NumeroLinea: String(i + 1),
      CodigoCABYS: l.cabys_code ?? '',
      Cantidad: num(l.quantity),
      UnidadMedida: l.unit ?? 'Unid',
      Detalle: l.product_name,
      PrecioUnitario: money(l.unit_price),
      MontoTotal: money(montoTotal),
      SubTotal: money(subtotal),
      BaseImponible: money(subtotal),
      MontoTotalLinea: money(subtotal + impuestoMonto),
    };
    if (l.sku) linea.CodigoComercial = [{ Tipo: '04', Codigo: l.sku }];
    if (tarifa > 0) {
      linea.Impuesto = [{
        Codigo: '01',
        CodigoTarifaIVA: codigoTarifaIVA(tarifa),
        Tarifa: String(tarifa),
        Monto: money(impuestoMonto),
      }];
      linea.ImpuestoNeto = money(impuestoMonto);
    }
    // Requerido por Hacienda: impuesto asumido por el emisor de fábrica (0 si no aplica).
    linea.ImpuestoAsumidoEmisorFabrica = '0';
    return linea;
  });

  const totalComprobante = Math.round(Number(inv.total ?? 0) * 100) / 100;

  // Facturemos indica: NO enviar Clave ni NumeroConsecutivo (los asigna su API;
  // si mandamos "0" los toma como valor 0). Y el contenido de `Factura` va SIN el
  // wrapper TiqueteElectronico/FacturaElectronica.
  const cuerpo: any = {
    ProveedorSistemas: emisor.proveedor_sistemas ?? '',
    CodigoActividadEmisor: emisor.economic_activity_code ?? '',
    FechaEmision: fechaCR(inv.issued_at),
    Emisor: {
      Nombre: emisor.name,
      Identificacion: { Tipo: emisor.identification_type, Numero: emisor.identification },
      Ubicacion: {
        Provincia: prov1(emisor.province_code),   // 1 díg
        Canton: pad2(emisor.canton_code),         // 2 díg
        Distrito: pad2(emisor.district_code),     // 2 díg
        OtrasSenas: emisor.address ?? '',
      },
      // Hacienda/Facturemos espera CorreoElectronico como ARRAY de strings.
      CorreoElectronico: emisor.email ? [emisor.email] : [],
    },
    Receptor: receptor && receptor.identification
      ? {
          Nombre: receptor.name ?? 'Cliente',
          Identificacion: { Tipo: receptor.identification_type ?? '01', Numero: receptor.identification },
          ...(receptor.email ? { CorreoElectronico: [receptor.email] } : {}),
        }
      : { Nombre: receptor?.name || 'Cliente General', NombreComercial: 'Cliente General' },
    CondicionVenta: condicionVenta,
    PlazoCredito: '0',
    DetalleServicio: {
      // Facturemos espera SIEMPRE un array (aunque sea una sola línea); si mandamos
      // un objeto, su parser lo ve como "detalle vacío".
      LineaDetalle: lineaDetalle,
    },
    ResumenFactura: {
      MedioPago: [{ TipoMedioPago: medioPago, TotalMedioPago: money(totalComprobante) }],
    },
    Otros: {
      OtroTexto: [
        { Codigo: 'Observaciones', Value: condicionVenta === '02' ? 'Venta a crédito' : 'Venta de contado' },
        { Codigo: 'RecalcularResumen', Value: '1' },
      ],
    },
  };

  // Sin wrapper: el contenido de `Factura` son directamente los campos del documento.
  // El tipo (tiquete/factura) lo determina el TipoComprobante del ConsecutivoModel.
  void esFactura;
  return JSON.stringify(cuerpo);
}
