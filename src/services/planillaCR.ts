import { db } from '../db/client.js';

/**
 * EL CÁLCULO DE LA PLANILLA DE COSTA RICA.
 *
 * Antes la planilla usaba DOS números y nada más: 10,67% de cuota obrera y
 * 26,67% de cuota patronal. Eso tenía tres problemas, y los tres salían a la
 * luz en el primer reclamo de un empleado:
 *
 *   1. No se podía explicar. «Se le rebajó ₡53.350» no dice nada; «SEM
 *      ₡27.500, IVM ₡21.650, Banco Popular ₡5.000» sí, y es lo que el
 *      trabajador tiene derecho a ver en su comprobante de pago.
 *   2. El INS estaba metido adentro del 26,67% y el comentario decía que lo
 *      incluía. El seguro de riesgos del trabajo es una PÓLIZA APARTE, con
 *      tarifa según la actividad del negocio: una soda y una ferretería no
 *      pagan lo mismo. Mezclado ahí, nadie podía ajustarlo.
 *   3. No había impuesto sobre la renta. Un salario de ₡1.500.000 salía con
 *      el neto equivocado por más de ₡60.000 al mes.
 *
 * ── Las tasas no están clavadas en el código ─────────────────────────────
 * Cambian por ley cada año. Si estuvieran en el código, cada enero habría que
 * desplegar una versión nueva para que la planilla saliera bien. Están acá
 * como VALORES POR OMISIÓN y el negocio puede ajustarlas sin tocar nada.
 *
 * ── Qué está firme y qué no ──────────────────────────────────────────────
 * Las tasas de 2026 que vienen abajo coinciden en la CCSS, La Nación y las
 * guías de nómina. Dos cosas NO están firmes, y por eso son configurables en
 * vez de decididas acá:
 *
 *   · La TARIFA DEL INS. El 1% es referencial; la real sale de la póliza del
 *     negocio y depende de su actividad.
 *   · La BASE del impuesto sobre la renta. Las fuentes se contradicen sobre
 *     si se calcula sobre el bruto o sobre el bruto menos la cuota obrera.
 *     Por omisión va sobre el bruto, que es lo que dicen las fuentes más
 *     recientes citando el decreto, y se puede cambiar.
 *
 * Donde la ley es ambigua, el sistema no elige en silencio: muestra la
 * opción y deja el número a la vista.
 */

const c2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;

export interface Renglon { id: string; label: string; pct: number; monto: number }
export interface TasaConfig { id: string; label: string; pct: number; nota?: string }

export interface TramoRenta { desde: number; hasta: number | null; pct: number }

export interface TasasPlanilla {
  /** Para qué año son estas tasas. Se muestra en pantalla. */
  vigente: string;
  /** Lo que se le REBAJA al trabajador del salario. */
  obrero: TasaConfig[];
  /** Lo que paga el negocio ADEMÁS del salario. */
  patronal: TasaConfig[];
  /** Riesgos del trabajo. Aparte porque es una póliza del INS, no de la CCSS. */
  ins: { pct: number; label: string; nota: string; activo: boolean };
  renta: {
    activo: boolean;
    /** 'bruto' o 'bruto_menos_ccss'. Ver la nota de arriba. */
    base: 'bruto' | 'bruto_menos_ccss';
    tramos: TramoRenta[];
    credito_hijo: number;
    credito_conyuge: number;
  };
  /** Base Mínima Contributiva: el piso sobre el que la CCSS cobra. */
  bmc: { aplicar: boolean; sem: number; ivm: number; nota: string };
}

/**
 * LAS TASAS DE 2026.
 *
 * Cuota obrera 10,83% y patronal 26,83% (el INS va aparte, así que el
 * patronal de acá suma 25,83% y con el INS da 26,83%). El IVM subió el 1.º
 * de enero de 2026: obrero de 4,17 a 4,33 y patronal de 5,42 a 5,58, por el
 * escalonamiento que lleva el IVM total a 11,66% entre 2026 y 2028.
 */
export const TASAS_2026: TasasPlanilla = {
  vigente: '2026',
  obrero: [
    { id: 'sem', label: 'CCSS — Enfermedad y Maternidad (SEM)', pct: 5.50 },
    { id: 'ivm', label: 'CCSS — Invalidez, Vejez y Muerte (IVM)', pct: 4.33,
      nota: 'Subió de 4,17% el 1.º de enero de 2026.' },
    { id: 'bpdc', label: 'Banco Popular — aporte del trabajador', pct: 1.00 },
  ],
  patronal: [
    { id: 'sem', label: 'CCSS — Enfermedad y Maternidad (SEM)', pct: 9.25 },
    { id: 'ivm', label: 'CCSS — Invalidez, Vejez y Muerte (IVM)', pct: 5.58,
      nota: 'Subió de 5,42% el 1.º de enero de 2026.' },
    { id: 'bpdc_ccss', label: 'Banco Popular — cuota patronal', pct: 0.25 },
    { id: 'asignaciones', label: 'Asignaciones Familiares (FODESAF)', pct: 5.00 },
    { id: 'imas', label: 'IMAS', pct: 0.50 },
    { id: 'ina', label: 'INA', pct: 1.50 },
    { id: 'fcl', label: 'Fondo de Capitalización Laboral (FCL)', pct: 1.50 },
    { id: 'rop', label: 'Pensión complementaria (ROP)', pct: 2.00 },
    { id: 'bpdc_lpt', label: 'Banco Popular — Ley de Protección al Trabajador', pct: 0.25 },
  ],
  ins: {
    pct: 1.00, label: 'INS — Riesgos del Trabajo', activo: true,
    nota: 'Tarifa REFERENCIAL. La real sale de la póliza del negocio y depende de su '
      + 'actividad económica: consultala en el INS y ponela acá.',
  },
  renta: {
    activo: true,
    base: 'bruto',
    /* Decreto 45333-H, vigente desde el 1.º de enero de 2026. La tarifa se
       aplica solo al EXCESO de cada tramo, no a todo el salario. */
    tramos: [
      { desde: 0,         hasta: 918_000,   pct: 0 },
      { desde: 918_000,   hasta: 1_347_000, pct: 10 },
      { desde: 1_347_000, hasta: 2_364_000, pct: 15 },
      { desde: 2_364_000, hasta: 4_727_000, pct: 20 },
      { desde: 4_727_000, hasta: null,      pct: 25 },
    ],
    credito_hijo: 1_710,
    credito_conyuge: 2_590,
  },
  bmc: {
    aplicar: false,
    sem: 346_789,
    ivm: 324_590,
    nota: 'La CCSS cobra sobre un piso mínimo. Si se activa, a quien gana menos que ese '
      + 'piso se le calculan las cuotas sobre el piso y no sobre su salario: el trabajador '
      + 'recibe menos neto y el negocio paga más carga. Afecta sobre todo a medio tiempo. '
      + 'Viene apagado para no cambiar planillas que ya se venían haciendo de otra forma.',
  },
};

/** Tabla que todavía no existe (migración sin correr). */
const sinTabla = (e: any) =>
  !!e && /does not exist|schema cache|Could not find the table|column .* does not exist/i.test(String(e.message ?? e));

/**
 * LAS TASAS DEL NEGOCIO.
 *
 * Lo guardado se mezcla ENCIMA de los valores por omisión en vez de
 * reemplazarlos: si mañana se agrega un rubro nuevo a la ley, el negocio que
 * guardó su configuración el año pasado lo recibe igual, en vez de quedarse
 * con una lista incompleta sin que nadie lo note.
 */
export async function cargarTasas(tenantId: string): Promise<TasasPlanilla & { guardadas: boolean }> {
  try {
    const { data, error } = await db.from('payroll_settings')
      .select('config').eq('tenant_id', tenantId).maybeSingle();
    if (error) throw error;
    const cfg = (data as any)?.config;
    if (!cfg) return { ...TASAS_2026, guardadas: false };
    return {
      vigente: cfg.vigente ?? TASAS_2026.vigente,
      obrero: Array.isArray(cfg.obrero) && cfg.obrero.length ? cfg.obrero : TASAS_2026.obrero,
      patronal: Array.isArray(cfg.patronal) && cfg.patronal.length ? cfg.patronal : TASAS_2026.patronal,
      ins: { ...TASAS_2026.ins, ...(cfg.ins ?? {}) },
      renta: {
        ...TASAS_2026.renta, ...(cfg.renta ?? {}),
        tramos: Array.isArray(cfg.renta?.tramos) && cfg.renta.tramos.length
          ? cfg.renta.tramos : TASAS_2026.renta.tramos,
      },
      bmc: { ...TASAS_2026.bmc, ...(cfg.bmc ?? {}) },
      guardadas: true,
    };
  } catch (e) {
    if (sinTabla(e)) return { ...TASAS_2026, guardadas: false };
    throw e;
  }
}

export async function guardarTasas(tenantId: string, config: any, userId?: string) {
  const { error } = await db.from('payroll_settings').upsert({
    tenant_id: tenantId, config,
    updated_at: new Date().toISOString(), updated_by: userId ?? null,
  }, { onConflict: 'tenant_id' });
  if (error) {
    if (sinTabla(error)) throw new Error('Falta correr la migración 149_planilla_deducciones.sql.');
    throw new Error(error.message);
  }
  return cargarTasas(tenantId);
}

const suma = (rs: Renglon[]) => c2(rs.reduce((s, r) => s + r.monto, 0));

/** Aplica una lista de tasas a una base y devuelve el desglose. */
function aplicar(tasas: TasaConfig[], base: number): Renglon[] {
  return tasas
    .filter(t => Number(t.pct) > 0)
    .map(t => ({ id: t.id, label: t.label, pct: Number(t.pct), monto: c2(base * Number(t.pct) / 100) }));
}

/**
 * EL PERÍODO, en meses.
 *
 * Los tramos del impuesto y la base mínima contributiva son MENSUALES. Una
 * planilla quincenal que los aplicara enteros le cobraría al empleado como si
 * ganara el doble: el tramo exento de ₡918.000 se consumiría dos veces al
 * mes. El factor los pone a escala del período.
 */
export function factorDelPeriodo(desde: string, hasta: string): number {
  const a = new Date(`${String(desde).slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${String(hasta).slice(0, 10)}T00:00:00Z`).getTime();
  if (isNaN(a) || isNaN(b) || b < a) return 1;
  const dias = Math.round((b - a) / 86_400_000) + 1;
  /* Un mes natural (28 a 31 días) cuenta como un mes entero: si no, febrero
     daría 0,93 y los tramos saldrían distintos cada mes sin motivo. */
  if (dias >= 28 && dias <= 31) return 1;
  return c2(dias / 30);
}

/**
 * EL IMPUESTO SOBRE LA RENTA DEL SALARIO.
 *
 * Por tramos y solo sobre el exceso de cada uno: quien gana ₡1.000.000 no
 * paga 10% de un millón, paga 10% de los ₡82.000 que pasan del tramo exento.
 * Confundir eso es el error clásico y da un impuesto diez veces mayor.
 *
 * Los créditos familiares se restan DEL IMPUESTO, no de la base, y no pueden
 * dejarlo negativo: el Estado no devuelve plata por tener hijos.
 */
export function calcularRenta(opts: {
  base: number;
  tasas: TasasPlanilla;
  hijos?: number;
  conyuge?: boolean;
  factor?: number;
}): { total: number; detalle: Renglon[]; creditos: number; base: number; exento: boolean } {
  const f = opts.factor && opts.factor > 0 ? opts.factor : 1;
  const base = c2(opts.base);
  const detalle: Renglon[] = [];
  if (!opts.tasas.renta.activo || base <= 0) {
    return { total: 0, detalle, creditos: 0, base, exento: true };
  }

  let impuesto = 0;
  for (const t of opts.tasas.renta.tramos) {
    if (Number(t.pct) <= 0) continue;
    const desde = c2(Number(t.desde) * f);
    const hasta = t.hasta == null ? Infinity : c2(Number(t.hasta) * f);
    if (base <= desde) continue;
    const gravado = c2(Math.min(base, hasta) - desde);
    if (gravado <= 0) continue;
    const monto = c2(gravado * Number(t.pct) / 100);
    impuesto = c2(impuesto + monto);
    detalle.push({
      id: `tramo_${t.pct}`,
      label: `${t.pct}% sobre ${fmtRango(desde, hasta)}`,
      pct: Number(t.pct), monto,
    });
  }

  const creditos = c2(
    (Math.max(0, Math.round(Number(opts.hijos) || 0)) * Number(opts.tasas.renta.credito_hijo) * f)
    + (opts.conyuge ? Number(opts.tasas.renta.credito_conyuge) * f : 0),
  );
  /* El crédito no puede volverse una devolución: se topa en el impuesto. */
  const aplicado = Math.min(creditos, impuesto);
  if (aplicado > 0) {
    detalle.push({ id: 'creditos', label: 'Créditos por cargas familiares', pct: 0, monto: -aplicado });
  }

  return {
    total: c2(impuesto - aplicado),
    detalle, creditos: aplicado, base,
    exento: impuesto === 0,
  };
}

const fmtRango = (desde: number, hasta: number) =>
  hasta === Infinity
    ? `el exceso de ₡${Math.round(desde).toLocaleString('es-CR')}`
    : `₡${Math.round(desde).toLocaleString('es-CR')}–₡${Math.round(hasta).toLocaleString('es-CR')}`;

export interface DeduccionEmpleado {
  id: string;
  tipo: string;
  label: string;
  modo: 'fijo' | 'porcentaje';
  monto: number;
  pct: number;
  tope: number | null;
  saldo_restante: number | null;
  desde: string | null;
  hasta: string | null;
  activo: boolean;
  /** Las que la ley protege del límite de embargo. */
  prioritaria?: boolean;
}

/** Deducciones que NO se topan: la ley las trata aparte. */
const PRIORITARIAS = new Set(['pension_alimentaria']);

/**
 * LAS DEDUCCIONES DEL EMPLEADO.
 *
 * Préstamos, asociación solidarista, cooperativa, pensión alimentaria,
 * embargos. Lo que antes no se podía anotar en ninguna parte: las columnas
 * `advances` y `other_deductions` existían y siempre valían cero, así que el
 * neto que mostraba el sistema no era el que la persona recibía.
 *
 * ── Un préstamo se detiene solo ──────────────────────────────────────────
 * Si tiene saldo, la cuota del mes nunca pasa del saldo que queda. Sin eso,
 * un préstamo de ₡200.000 en cuotas de ₡25.000 seguiría rebajando el mes
 * nueve y el diez.
 */
export function aplicarDeducciones(opts: {
  deducciones: DeduccionEmpleado[];
  bruto: number;
  hasta: string;
  factor?: number;
}): { total: number; detalle: Renglon[] } {
  const f = opts.factor && opts.factor > 0 ? opts.factor : 1;
  const detalle: Renglon[] = [];
  for (const d of opts.deducciones) {
    if (!d.activo) continue;
    if (d.desde && String(d.desde).slice(0, 10) > opts.hasta) continue;
    if (d.hasta && String(d.hasta).slice(0, 10) < opts.hasta) continue;

    let monto = d.modo === 'porcentaje'
      ? c2(opts.bruto * (Number(d.pct) || 0) / 100)
      : c2((Number(d.monto) || 0) * f);
    if (d.tope != null && Number(d.tope) > 0) monto = Math.min(monto, c2(Number(d.tope) * f));
    /* El saldo manda: la última cuota es lo que falta, no la cuota llena. */
    if (d.saldo_restante != null) monto = Math.min(monto, c2(Number(d.saldo_restante)));
    if (monto <= 0) continue;

    detalle.push({
      id: d.id, label: d.label || d.tipo, pct: d.modo === 'porcentaje' ? Number(d.pct) : 0, monto,
    });
  }
  return { total: suma(detalle), detalle };
}

export async function deduccionesDe(tenantId: string, employeeIds: string[]):
  Promise<Map<string, DeduccionEmpleado[]>> {
  const porEmpleado = new Map<string, DeduccionEmpleado[]>();
  if (!employeeIds.length) return porEmpleado;
  try {
    const { data, error } = await db.from('employee_deductions')
      .select('*').eq('tenant_id', tenantId).eq('activo', true).in('employee_id', employeeIds);
    if (error) throw error;
    for (const d of ((data ?? []) as any[])) {
      const fila: DeduccionEmpleado = {
        id: String(d.id), tipo: String(d.tipo), label: String(d.label ?? d.tipo),
        modo: d.modo === 'porcentaje' ? 'porcentaje' : 'fijo',
        monto: Number(d.monto) || 0, pct: Number(d.pct) || 0,
        tope: d.tope == null ? null : Number(d.tope),
        saldo_restante: d.saldo_restante == null ? null : Number(d.saldo_restante),
        desde: d.desde ?? null, hasta: d.hasta ?? null,
        activo: d.activo !== false,
        prioritaria: PRIORITARIAS.has(String(d.tipo)),
      };
      porEmpleado.set(String(d.employee_id), [...(porEmpleado.get(String(d.employee_id)) ?? []), fila]);
    }
  } catch (e) {
    if (!sinTabla(e)) throw e;   // sin la migración, la planilla sale sin deducciones
  }
  return porEmpleado;
}

/**
 * LA BASE CONTRIBUTIVA.
 *
 * Normalmente es el bruto. Con la base mínima activada, a quien gana menos
 * que el piso de la CCSS se le calculan las cuotas sobre el piso.
 */
function baseContributiva(bruto: number, piso: number, aplicar: boolean, factor: number) {
  if (!aplicar || piso <= 0) return { base: bruto, ajustada: false };
  const minimo = c2(piso * factor);
  return bruto < minimo ? { base: minimo, ajustada: true } : { base: bruto, ajustada: false };
}

export interface ResultadoLinea {
  bruto: number;
  /** Cuota obrera: lo que se le rebaja por la CCSS y el Banco Popular. */
  obrero: number;
  obrero_detalle: Renglon[];
  /** Impuesto sobre la renta retenido. */
  renta: number;
  renta_detalle: Renglon[];
  /** Préstamos, solidarista, embargos, adelantos. */
  deducciones: number;
  deducciones_detalle: Renglon[];
  /** Cuota patronal (no se le rebaja al empleado: la paga el negocio). */
  patronal: number;
  patronal_detalle: Renglon[];
  ins: number;
  neto: number;
  /** Lo que le cuesta esta persona al negocio. */
  costo: number;
  base_contributiva: number;
  bmc_ajustada: boolean;
  /** Avisos para mostrar en pantalla. Nunca cambian el número. */
  avisos: string[];
}

/**
 * LA LÍNEA COMPLETA DE UN EMPLEADO.
 *
 * El orden importa y es el de la ley: primero las cargas obligatorias y el
 * impuesto, después lo demás. Lo que queda es lo que la persona recibe.
 */
export function calcularLinea(opts: {
  bruto: number;
  tasas: TasasPlanilla;
  deducciones?: DeduccionEmpleado[];
  adelantos?: number;
  otros?: number;
  hijos?: number;
  conyuge?: boolean;
  exento_renta?: boolean;
  desde: string;
  hasta: string;
}): ResultadoLinea {
  const factor = factorDelPeriodo(opts.desde, opts.hasta);
  const bruto = c2(opts.bruto);
  const avisos: string[] = [];

  // ── Cuota obrera, sobre la base contributiva ──
  const pisoObrero = Math.max(opts.tasas.bmc.sem, opts.tasas.bmc.ivm);
  const bc = baseContributiva(bruto, pisoObrero, opts.tasas.bmc.aplicar, factor);
  const obreroDet = aplicar(opts.tasas.obrero, bc.base);
  const obrero = suma(obreroDet);
  if (bc.ajustada) {
    avisos.push(`Las cuotas se calcularon sobre la base mínima contributiva `
      + `(₡${Math.round(bc.base).toLocaleString('es-CR')}) y no sobre el salario, que es menor.`);
  } else if (!opts.tasas.bmc.aplicar && bruto > 0 && bruto < c2(pisoObrero * factor)) {
    avisos.push(`El salario está por debajo de la base mínima contributiva de la CCSS `
      + `(₡${Math.round(pisoObrero * factor).toLocaleString('es-CR')}). La CCSS podría cobrar las `
      + `cuotas sobre ese piso. El ajuste está apagado en la configuración de la planilla.`);
  }

  // ── Impuesto sobre la renta ──
  const baseRenta = opts.tasas.renta.base === 'bruto_menos_ccss' ? c2(bruto - obrero) : bruto;
  const renta = opts.exento_renta
    ? { total: 0, detalle: [] as Renglon[], creditos: 0, base: baseRenta, exento: true }
    : calcularRenta({ base: baseRenta, tasas: opts.tasas, hijos: opts.hijos, conyuge: opts.conyuge, factor });

  // ── Lo demás ──
  const ded = aplicarDeducciones({
    deducciones: opts.deducciones ?? [], bruto, hasta: opts.hasta, factor,
  });
  const extra: Renglon[] = [];
  if ((opts.adelantos ?? 0) > 0) {
    extra.push({ id: 'adelantos', label: 'Adelantos del período', pct: 0, monto: c2(opts.adelantos) });
  }
  if ((opts.otros ?? 0) > 0) {
    extra.push({ id: 'otros', label: 'Otros descuentos', pct: 0, monto: c2(opts.otros) });
  }
  const dedDetalle = [...ded.detalle, ...extra];
  const deducciones = suma(dedDetalle);

  // ── Cuota patronal e INS ──
  const patronalDet = aplicar(opts.tasas.patronal, bc.base);
  const patronal = suma(patronalDet);
  const ins = opts.tasas.ins.activo ? c2(bc.base * Number(opts.tasas.ins.pct) / 100) : 0;

  const neto = c2(bruto - obrero - renta.total - deducciones);

  /**
   * El aviso del salario inembargable.
   *
   * No se topa automáticamente: el límite legal depende del tipo de deuda
   * —la pensión alimentaria no se topa— y de resoluciones que el sistema no
   * conoce. Rebajar de menos haría que el negocio incumpla una orden
   * judicial; rebajar de más es ilegal. Lo que corresponde es avisar con el
   * número y dejar la decisión en quien sí tiene el expediente.
   */
  const noPrioritarias = suma(dedDetalle.filter(r => {
    const d = (opts.deducciones ?? []).find(x => x.id === r.id);
    return !d?.prioritaria;
  }));
  if (bruto > 0 && noPrioritarias > c2((bruto - obrero - renta.total) * 0.5)) {
    avisos.push('Los descuentos que no son pensión alimentaria se llevan más de la mitad de lo que '
      + 'queda después de cargas e impuesto. Revisá el límite del salario inembargable.');
  }
  if (neto < 0) {
    avisos.push('Los descuentos superan el salario del período: el neto quedó en negativo. '
      + 'Alguna cuota tiene que bajar o posponerse.');
  }

  return {
    bruto,
    obrero, obrero_detalle: obreroDet,
    renta: renta.total, renta_detalle: renta.detalle,
    deducciones, deducciones_detalle: dedDetalle,
    patronal, patronal_detalle: patronalDet,
    ins,
    neto,
    costo: c2(bruto + patronal + ins),
    base_contributiva: bc.base,
    bmc_ajustada: bc.ajustada,
    avisos,
  };
}

/** Los totales del período, con el desglose sumado rubro por rubro. */
export function totalizar(lineas: ResultadoLinea[]) {
  const juntar = (sacar: (l: ResultadoLinea) => Renglon[]) => {
    const m = new Map<string, Renglon>();
    for (const l of lineas) {
      for (const r of sacar(l)) {
        const a = m.get(r.id) ?? { ...r, monto: 0 };
        a.monto = c2(a.monto + r.monto);
        m.set(r.id, a);
      }
    }
    return [...m.values()];
  };
  const t = (f: (l: ResultadoLinea) => number) => c2(lineas.reduce((s, l) => s + f(l), 0));
  return {
    gross: t(l => l.bruto),
    employee_charges: t(l => l.obrero),
    employee_charges_detail: juntar(l => l.obrero_detalle),
    income_tax: t(l => l.renta),
    income_tax_detail: juntar(l => l.renta_detalle),
    other_deductions: t(l => l.deducciones),
    other_deductions_detail: juntar(l => l.deducciones_detalle),
    employer_charges: t(l => l.patronal),
    employer_charges_detail: juntar(l => l.patronal_detalle),
    ins_amount: t(l => l.ins),
    net: t(l => l.neto),
    total_cost: t(l => l.costo),
    employees_count: lineas.length,
  };
}

/**
 * BAJAR EL SALDO DE LOS PRÉSTAMOS cuando la planilla se paga.
 *
 * Se hace al PAGAR y no al calcular: una planilla en borrador se recalcula
 * varias veces, y si el saldo bajara en cada cálculo el préstamo quedaría
 * saldado sin que nadie le haya rebajado nada.
 */
export async function abonarDeducciones(tenantId: string, items: any[]) {
  const abonos = new Map<string, number>();
  for (const it of items) {
    const det = Array.isArray(it?.deductions_detail) ? it.deductions_detail : [];
    for (const r of det) {
      if (!r?.id || r.id === 'adelantos' || r.id === 'otros') continue;
      abonos.set(String(r.id), c2((abonos.get(String(r.id)) ?? 0) + Number(r.monto || 0)));
    }
  }
  if (!abonos.size) return { abonadas: 0, saldadas: 0 };

  let abonadas = 0, saldadas = 0;
  try {
    const { data } = await db.from('employee_deductions')
      .select('id, saldo_restante').eq('tenant_id', tenantId).in('id', [...abonos.keys()]);
    for (const d of ((data ?? []) as any[])) {
      if (d.saldo_restante == null) continue;        // sin saldo: no es un préstamo
      const resta = c2(Number(d.saldo_restante) - (abonos.get(String(d.id)) ?? 0));
      const nuevo = Math.max(0, resta);
      await db.from('employee_deductions')
        .update({ saldo_restante: nuevo, ...(nuevo === 0 ? { activo: false } : {}) })
        .eq('id', d.id).eq('tenant_id', tenantId);
      abonadas++;
      if (nuevo === 0) saldadas++;
    }
  } catch (e) {
    if (!sinTabla(e)) throw e;
  }
  return { abonadas, saldadas };
}
