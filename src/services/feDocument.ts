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

// Hacienda MedioPago: 01 efectivo, 02 tarjeta, 03 cheque,
// 04 transferencia/depósito, 05 canje, 06 SINPE Móvil, 07 plataforma digital, 99 otros.
const MEDIO_PAGO: Record<string, string> = {
  cash: '01', card: '02', check: '03', transfer: '04', deposit: '04',
  sinpe: '06', sinpe_movil: '06', credit: '02', mixed: '01',
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

// ── Unidad de medida → código del catálogo de Hacienda v4.4 ───────────────────
// Hacienda es CASE-SENSITIVE: el kilogramo es "Kg" (no "kg"), litro "L", etc.
// Los códigos válidos exactos (subconjunto comercial del XSD v4.4).
const UNIDADES_VALIDAS = new Set([
  'Unid', 'Kg', 'G', 'L', 'mL', 'm', 'cm', 'Cm', 'Mm', 'Km', 'm²', 'm³',
  'Gal', 'Oz', 'h', 'Min', 's', 'd', 'Sp', 'Spe', 'St', 'Al', 'Alc', 'Os',
  'Otros', 'Cc', 'Cu', 'Fa', 'Qq', 'Acv', 't',
]);
// Variantes comunes (en minúscula) → código oficial.
const UNIDAD_MAP: Record<string, string> = {
  unid: 'Unid', und: 'Unid', un: 'Unid', u: 'Unid', uni: 'Unid',
  unidad: 'Unid', unidades: 'Unid', pza: 'Unid', pzas: 'Unid', pieza: 'Unid',
  piezas: 'Unid', pcs: 'Unid', ea: 'Unid', caja: 'Unid', cajas: 'Unid',
  paquete: 'Unid', paq: 'Unid', bolsa: 'Unid', saco: 'Unid', doc: 'Unid',
  kg: 'Kg', kgs: 'Kg', kilo: 'Kg', kilos: 'Kg', kilogramo: 'Kg', kilogramos: 'Kg', k: 'Kg',
  g: 'G', gr: 'G', grs: 'G', gramo: 'G', gramos: 'G',
  l: 'L', lt: 'L', ltr: 'L', lts: 'L', litro: 'L', litros: 'L',
  ml: 'mL', mililitro: 'mL', mililitros: 'mL', cc: 'mL',
  m: 'm', metro: 'm', metros: 'm', mt: 'm', mts: 'm',
  cm: 'cm', centimetro: 'cm', centimetros: 'cm',
  mm: 'Mm', km: 'Km',
  m2: 'm²', m3: 'm³',
  gal: 'Gal', galon: 'Gal', galones: 'Gal',
  oz: 'Oz', onza: 'Oz', onzas: 'Oz',
  h: 'h', hr: 'h', hrs: 'h', hora: 'h', horas: 'h',
  min: 'Min', minuto: 'Min', minutos: 'Min',
  sp: 'Sp', serv: 'Sp', servicio: 'Sp', servicios: 'Sp',
  qq: 'Qq', quintal: 'Qq', quintales: 'Qq', t: 't', ton: 't', tonelada: 't',
};

/** Normaliza la unidad del producto al código exacto del catálogo de Hacienda.
 *  Si ya es un código válido, lo respeta; si no, mapea variantes comunes;
 *  desconocidas → "Unid" (siempre aceptada). */
export function haciendaUnit(unit?: string | null): string {
  const raw = String(unit ?? '').trim();
  if (!raw) return 'Unid';
  if (UNIDADES_VALIDAS.has(raw)) return raw;      // ya es válido (respeta mayúsculas)
  return UNIDAD_MAP[raw.toLowerCase()] ?? 'Unid';
}

export function buildConsecutivo(
  inv: FEInvoice,
  opts: { sucursal?: string; terminal?: string; situacion?: string; tipoComprobante?: string } = {},
): ConsecutivoModel {
  return {
    Sucursal: pad(opts.sucursal ?? '1', 3),
    Terminal: pad(opts.terminal ?? '1', 5),
    TipoComprobante: opts.tipoComprobante ?? tipoComprobante(inv.document_type),
    ConsecutivoInterno: pad(inv.invoice_number, 10),
    SituacionDelComprobante: opts.situacion ?? '1',
  };
}

/** Referencia al documento original (para Nota de Crédito de anulación). */
export interface FEReference {
  tipoDoc: string;    // 04 tiquete, 01 factura…
  numero: string;     // clave de 50 díg del documento original
  fecha?: string;     // fecha de emisión del original (ISO)
  codigo?: string;    // 01 = anula documento de referencia
  razon?: string;
}

/** ISO-8601 con offset de Costa Rica (-06:00). Acota a no-futura. */
function fechaCR(issuedAt?: string): string {
  let d = issuedAt ? new Date(issuedAt) : new Date();
  if (isNaN(d.getTime()) || d.getTime() > Date.now()) d = new Date();  // inválida/futura → ahora
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
  options?: { tipoComprobante?: string; reference?: FEReference },
): string {
  const tipo = options?.tipoComprobante ?? tipoComprobante(inv.document_type);
  const esFactura = tipo === '01';
  const condicionVenta = inv.payment_method === 'credit' ? '02' : '01';
  const medioPago = MEDIO_PAGO[inv.payment_method] ?? '01';

  const lineaDetalle = lines.map((l, i) => {
    const tarifa = Number(l.iva_rate ?? 0);
    const montoTotal = Math.round(l.unit_price * l.quantity * 100) / 100;
    const subtotal = Math.round(Number(l.subtotal ?? montoTotal) * 100) / 100;
    // Hacienda exige SubTotal = MontoTotal − Descuento. Si lo cobrado (subtotal)
    // es menor que precio×cantidad (precio especial del cliente, promo, % desc.),
    // la diferencia se declara como DESCUENTO de línea; si no, la validación falla.
    const descuento = Math.round((montoTotal - subtotal) * 100) / 100;
    const impuestoMonto = Math.round(subtotal * (tarifa / 100) * 100) / 100;
    const linea: any = {
      NumeroLinea: String(i + 1),
      CodigoCABYS: l.cabys_code ?? '',
      Cantidad: num(l.quantity),
      UnidadMedida: haciendaUnit(l.unit),
      Detalle: l.product_name,
      PrecioUnitario: money(l.unit_price),
      MontoTotal: money(montoTotal),
      SubTotal: money(subtotal),
      BaseImponible: money(subtotal),
      MontoTotalLinea: money(subtotal + impuestoMonto),
    };
    if (descuento > 0.005) {
      // Hacienda v4.4 exige CodigoDescuento. Usamos '09' = Descuento Comercial
      // (precio especial de cliente / promo). NO usar 01/02/03 (regalía/
      // bonificación): esos disparan la validación de ImpuestoAsumidoEmisorFabrica.
      linea.Descuento = [{
        MontoDescuento: money(descuento),
        CodigoDescuento: '09',
        NaturalezaDescuento: 'Descuento comercial',
      }];
    }
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
          // OJO: en el Receptor, CorreoElectronico es STRING (no array como el Emisor).
          ...(receptor.email ? { CorreoElectronico: receptor.email } : {}),
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

  // Nota de Crédito: referencia al documento original que se anula.
  // InformacionReferencia = ARRAY. OJO: los campos del modelo de Facturemos son
  // TipoDocIR y FechaEmisionIR (no TipoDoc/FechaEmisionDoc como en la doc/XSD).
  if (options?.reference) {
    const r = options.reference;
    cuerpo.InformacionReferencia = [{
      TipoDocIR: r.tipoDoc,
      Numero: r.numero,
      FechaEmisionIR: r.fecha ? fechaCR(r.fecha) : fechaCR(),
      Codigo: r.codigo ?? '01',           // 01 = anula documento de referencia
      Razon: r.razon ?? 'Anulación de documento',
    }];
  }

  // Sin wrapper: el contenido de `Factura` son directamente los campos del documento.
  // El tipo (tiquete/factura) lo determina el TipoComprobante del ConsecutivoModel.
  void esFactura;
  return JSON.stringify(cuerpo);
}
