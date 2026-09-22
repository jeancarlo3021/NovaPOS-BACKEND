/**
 * Tipos y equivalencias del comprobante electrónico de Costa Rica.
 *
 *
 * Fase 3: Tiquete electrónico (04). Receptor opcional ("Cliente General").
 */

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
  proveedor_sistemas?: string;   // cédula del proveedor de sistemas
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
  third_party: '05', sinpe: '06', sinpe_movil: '06', digital: '07',
  other: '99', credit: '02', mixed: '01',
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
//
// La lista de abajo es EXACTAMENTE la que acepta el proveedor, copiada de su
// rechazo (factura #000177 de 2026-09-22):
//   «itemDetails.0.unitMeasurement: Value must be one of: 1,´,´´,°C,A,…,Unid»
//
// Es CASE-SENSITIVE y tiene trampas: el metro es «M» (no «m»), el centímetro
// «Cm», el gramo «G». Antes se mandaba «m» para los productos medidos en metros
// —que hasta parece lo correcto— y el comprobante se caía con un error que solo
// decía «la unidad no es válida». Lo que no está en la lista (hora, tonelada,
// día) se manda como «Otros», que siempre se acepta.
const UNIDADES_VALIDAS = new Set([
  '1', '´', '´´', '°C', 'A', 'A/m', 'A/m²', 'Al', 'Alc', 'B', 'Bq', 'C', 'C/kg',
  'C/m²', 'C/m³', 'Cd', 'cd/m²', 'Cm', 'D', 'eV', 'F', 'F/m', 'Gy', 'Gy/s', 'H',
  'H/m', 'Hz', 'I', 'J', 'J/(kg·K)', 'J/(mol·K)', 'J/K', 'J/kg', 'J/m³', 'J/mol',
  'K', 'Kat', 'kat/m³', 'Km', 'Kw', 'kWh', 'Lm', 'Lx', 'm/s', 'm/s²', 'Min', 'N',
  'N/m', 'N·m', 'Np', 'º', 'Os', 'Pa', 'Pa·s', 'Rad', 'rad/s', 'rad/s²', 'S',
  'Sp', 'Spe', 'Sr', 'St', 'Sv', 'T', 'Ua', 'V', 'V/m', 'W', 'W/(m·K)',
  'W/(m²·sr)', 'W/m²', 'W/sr', 'Wb', 'Ω', '1/m', 'Acv', 'Cc', 'Cu', 'Fa', 'G',
  'Gal', 'Kg', 'kg/m³', 'L', 'Ln', 'M', 'm²', 'm³', 'mL', 'Mm', 'Mol', 'mol/m³',
  'Otros', 'Oz', 'Qq', 'U', 'Unid',
]);
// Variantes comunes (en minúscula) → código oficial.
const UNIDAD_MAP: Record<string, string> = {
  unid: 'Unid', und: 'Unid', un: 'Unid', u: 'Unid', uni: 'Unid',
  unidad: 'Unid', unidades: 'Unid', pza: 'Unid', pzas: 'Unid', pieza: 'Unid',
  piezas: 'Unid', pcs: 'Unid', ea: 'Unid', caja: 'Unid', cajas: 'Unid',
  paquete: 'Unid', paq: 'Unid', paqu: 'Unid', bolsa: 'Unid', saco: 'Unid',
  bulto: 'Unid', bult: 'Unid', resma: 'Unid', resm: 'Unid', set: 'Unid', doc: 'Unid',
  kg: 'Kg', kgs: 'Kg', kilo: 'Kg', kilos: 'Kg', kilogramo: 'Kg', kilogramos: 'Kg', k: 'Kg',
  g: 'G', gr: 'G', grs: 'G', gramo: 'G', gramos: 'G',
  l: 'L', lt: 'L', ltr: 'L', lts: 'L', litro: 'L', litros: 'L',
  ml: 'mL', mililitro: 'mL', mililitros: 'mL', cc: 'Cc',
  // METRO: el código es «M», en mayúscula.
  m: 'M', metro: 'M', metros: 'M', mt: 'M', mts: 'M', mtr: 'M', ml_lineal: 'M',
  cm: 'Cm', centimetro: 'Cm', centimetros: 'Cm',
  mm: 'Mm', milimetro: 'Mm', milimetros: 'Mm',
  km: 'Km', kilometro: 'Km', kilometros: 'Km',
  m2: 'm²', 'm²': 'm²', mt2: 'm²', m3: 'm³', 'm³': 'm³', mt3: 'm³',
  gal: 'Gal', galon: 'Gal', galones: 'Gal',
  oz: 'Oz', onza: 'Oz', onzas: 'Oz',
  min: 'Min', minuto: 'Min', minutos: 'Min',
  sp: 'Sp', serv: 'Sp', servicio: 'Sp', servicios: 'Sp',
  qq: 'Qq', quintal: 'Qq', quintales: 'Qq',
  kw: 'Kw', kwh: 'kWh',
  // Sin código propio en la lista del proveedor: van como «Otros», que se acepta
  // siempre, en vez de tumbar el comprobante.
  h: 'Otros', hr: 'Otros', hrs: 'Otros', hora: 'Otros', horas: 'Otros',
  dia: 'D', dias: 'D', d: 'D',
  seg: 'S', segundo: 'S', segundos: 'S', s: 'S',
  t: 'Otros', ton: 'Otros', tonelada: 'Otros', toneladas: 'Otros',
};

/** Normaliza la unidad del producto al código exacto del catálogo de Hacienda.
 *  Si ya es un código válido, lo respeta; si no, mapea variantes comunes;
 *  desconocidas → "Unid" (siempre aceptada). */
/**
 * Códigos válidos que en una tienda SIEMPRE significan otra cosa.
 *
 * «K» es kelvin en el catálogo, pero ningún negocio vende en kelvin: en los
 * productos reales («POSTA DE CERDO (K)») quiere decir kilo. Como el código es
 * válido, se colaba tal cual y el comprobante salía en kelvin.
 */
const AMBIGUAS: Record<string, string> = { K: 'Kg' };

export function haciendaUnit(unit?: string | null): string {
  const raw = String(unit ?? '').trim();
  if (!raw) return 'Unid';
  if (AMBIGUAS[raw]) return AMBIGUAS[raw];
  if (UNIDADES_VALIDAS.has(raw)) return raw;      // ya es válido (respeta mayúsculas)
  return UNIDAD_MAP[raw.toLowerCase()] ?? 'Unid';
}
