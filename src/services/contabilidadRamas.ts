import { db } from '../db/client.js';
import { crearAsiento, asegurarCuentas } from './contabilidad.js';

/**
 * LAS RAMAS DEL MÓDULO CONTABLE.
 *
 * El núcleo (catálogo, diario, mayor, los tres informes) vive en
 * `contabilidad.ts`. Acá están las ramas que cuelgan de él:
 *
 *   · IMPUESTOS — el IVA del periodo, para la D-104.
 *   · ANTIGÜEDAD DE SALDOS — qué se debe y desde cuándo.
 *   · FLUJO DE CAJA — por dónde entró y por dónde salió la plata.
 *   · ACTIVOS FIJOS — la depreciación mensual.
 *   · CIERRE DE PERIODO — el mes que ya no se toca.
 *
 * ── Una decisión que atraviesa todo el archivo ───────────────────────────
 * Las tres primeras NO guardan nada: se calculan cada vez de lo que ya está
 * registrado. Una tabla de «resumen de IVA del mes» se ve eficiente y queda
 * mintiendo en cuanto alguien corrige una factura de ese mes.
 */

const c2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;
const hoyCR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });

/** El día de Costa Rica de una marca de tiempo. */
const diaCR = (iso: any) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
};

/** Último día del mes de un periodo 'YYYY-MM'. */
export function finDeMes(periodo: string): string {
  const [a, m] = periodo.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}

const inicioDeMes = (periodo: string) => `${periodo}-01`;

/** Tabla que no existe todavía (migración sin correr). */
const sinTabla = (e: any) =>
  !!e && /does not exist|relation .* does not exist|schema cache|Could not find the table/i.test(String(e.message ?? e));

// ══════════════════════════════════════════════════════════════════════════
// IMPUESTOS — EL IVA DEL PERIODO
// ══════════════════════════════════════════════════════════════════════════

/**
 * EL IVA DEL PERIODO, por los dos caminos.
 *
 * Se calcula de DOS fuentes distintas a propósito:
 *
 *   · los DOCUMENTOS (facturas, gastos, compras), que es lo que pide la
 *     D-104;
 *   · los LIBROS (las cuentas 2102 y 1105), que es lo que dice la
 *     contabilidad.
 *
 * Si no coinciden, hay documentos sin contabilizar — y eso es exactamente lo
 * que uno quiere saber ANTES de declarar, no después. Un informe que muestra
 * un solo número elige por el usuario cuál de los dos creer.
 */
export async function resumenIva(tenantId: string, desde: string, hasta: string) {
  /* Se pide un día de más en cada punta y se filtra por el día de Costa
     Rica: `issued_at` es UTC, y una venta de las 7 p.m. del 31 cae en el mes
     siguiente si se corta por UTC. En una declaración mensual eso mueve
     facturas de un periodo a otro. */
  const bordeDesde = new Date(`${desde}T00:00:00Z`); bordeDesde.setUTCDate(bordeDesde.getUTCDate() - 1);
  const bordeHasta = new Date(`${hasta}T00:00:00Z`); bordeHasta.setUTCDate(bordeHasta.getUTCDate() + 2);
  const enRango = (d: string) => d >= desde && d <= hasta;

  // ── VENTAS ──
  const ventas = { gravado: 0, exento: 0, iva: 0, docs: 0, anuladas: 0 };
  const porMes = new Map<string, { debito: number; credito: number }>();
  const mes = (d: string) => {
    const k = d.slice(0, 7);
    if (!porMes.has(k)) porMes.set(k, { debito: 0, credito: 0 });
    return porMes.get(k)!;
  };

  try {
    const { data } = await db.from('invoices')
      .select('id, invoice_number, issued_at, subtotal, tax_amount, total, status')
      .eq('tenant_id', tenantId)
      .gte('issued_at', bordeDesde.toISOString())
      .lte('issued_at', bordeHasta.toISOString())
      .limit(20000);
    for (const f of ((data ?? []) as any[])) {
      const d = diaCR(f.issued_at);
      if (!enRango(d)) continue;
      if (String(f.status) === 'cancelled') { ventas.anuladas++; continue; }
      const iva = c2(f.tax_amount);
      const neto = c2(Number(f.total) - iva);
      ventas.docs++;
      ventas.iva = c2(ventas.iva + iva);
      if (iva > 0) ventas.gravado = c2(ventas.gravado + neto);
      else ventas.exento = c2(ventas.exento + neto);
      mes(d).debito = c2(mes(d).debito + iva);
    }
  } catch (e) { if (!sinTabla(e)) throw e; }

  // ── COMPRAS Y GASTOS (el crédito fiscal) ──
  const compras = { neto: 0, iva: 0, docs: 0, sin_impuesto: 0 };
  const gastos = { neto: 0, iva: 0, docs: 0, sin_impuesto: 0 };

  for (const [tabla, acum, campoFecha] of [
    ['purchases', compras, 'created_at'] as const,
    ['expenses', gastos, 'date'] as const,
  ]) {
    try {
      let q = db.from(tabla).select('*').eq('tenant_id', tenantId).limit(20000);
      q = q.gte(campoFecha, desde).lte(campoFecha, `${hasta}T23:59:59.999Z`);
      const { data, error } = await q;
      if (error) throw error;
      for (const x of ((data ?? []) as any[])) {
        const d = String(x[campoFecha] ?? '').slice(0, 10);
        if (!enRango(d)) continue;
        const total = c2(x.total ?? x.amount);
        const iva = c2(x.tax_amount);
        if (total <= 0) continue;
        acum.docs++;
        acum.iva = c2(acum.iva + iva);
        acum.neto = c2(acum.neto + total - iva);
        /* Un gasto con impuesto en cero puede ser exento… o puede ser que
           nadie anotó el impuesto. Se cuentan aparte en vez de sumarlos al
           crédito fiscal: inventar el 13% de un monto bruto da un crédito
           que Hacienda no reconoce. */
        if (iva === 0) acum.sin_impuesto++;
        mes(d).credito = c2(mes(d).credito + iva);
      }
    } catch (e) { if (!sinTabla(e)) throw e; }
  }

  // ── LOS LIBROS: las cuentas de IVA ──
  const libros = { debito: 0, credito: 0, disponible: true };
  try {
    const { data: asientos, error } = await db.from('journal_entries')
      .select('id').eq('tenant_id', tenantId).eq('anulado', false)
      .neq('source_type', 'cierre')
      .gte('fecha', desde).lte('fecha', hasta);
    if (error) throw error;
    const ids = ((asientos ?? []) as any[]).map(a => a.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { data: ls } = await db.from('journal_lines')
        .select('code, debe, haber').in('entry_id', ids.slice(i, i + 200));
      for (const l of ((ls ?? []) as any[])) {
        if (l.code === '2102') libros.debito = c2(libros.debito + Number(l.haber) - Number(l.debe));
        if (l.code === '1105') libros.credito = c2(libros.credito + Number(l.debe) - Number(l.haber));
      }
    }
  } catch (e) { if (sinTabla(e)) libros.disponible = false; else throw e; }

  const creditoDocs = c2(compras.iva + gastos.iva);
  const porPagar = c2(ventas.iva - creditoDocs);

  return {
    desde, hasta,
    ventas, compras, gastos,
    credito_fiscal: creditoDocs,
    debito_fiscal: ventas.iva,
    /** Positivo: hay que pagarle a Hacienda. Negativo: queda saldo a favor. */
    iva_por_pagar: porPagar,
    libros,
    /* El cruce. Se compara con tolerancia de un colón: los redondeos de
       céntimos de cientos de facturas no son un descuadre. */
    calza: libros.disponible
      && Math.abs(libros.debito - ventas.iva) <= 1
      && Math.abs(libros.credito - creditoDocs) <= 1,
    diferencia_debito: libros.disponible ? c2(libros.debito - ventas.iva) : 0,
    diferencia_credito: libros.disponible ? c2(libros.credito - creditoDocs) : 0,
    por_mes: [...porMes.entries()].sort().map(([m, v]) => ({
      mes: m, debito: v.debito, credito: v.credito, por_pagar: c2(v.debito - v.credito),
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// ANTIGÜEDAD DE SALDOS
// ══════════════════════════════════════════════════════════════════════════

const TRAMOS = [
  { id: 'al_dia', label: 'Al día', min: -99999, max: 0 },
  { id: 'd1_30', label: '1 a 30 días', min: 1, max: 30 },
  { id: 'd31_60', label: '31 a 60 días', min: 31, max: 60 },
  { id: 'd61_90', label: '61 a 90 días', min: 61, max: 90 },
  { id: 'd90', label: 'Más de 90 días', min: 91, max: 999999 },
];

const diasDeAtraso = (vence: string | null, hoy: string): number => {
  if (!vence) return 0;                       // sin fecha de vencimiento: al día
  const a = new Date(`${hoy}T00:00:00Z`).getTime();
  const b = new Date(`${String(vence).slice(0, 10)}T00:00:00Z`).getTime();
  if (isNaN(b)) return 0;
  return Math.round((a - b) / 86_400_000);
};

const tramoDe = (dias: number) => TRAMOS.find(t => dias >= t.min && dias <= t.max)?.id ?? 'al_dia';

/**
 * ANTIGÜEDAD DE SALDOS: lo que se debe, ordenado por desde cuándo.
 *
 * Un total de cuentas por cobrar no dice nada: dos millones repartidos en
 * facturas de esta semana y dos millones con seis meses de atraso son dos
 * negocios distintos. El corte por tramos es lo que separa el cobro normal
 * de la plata que probablemente no vuelve.
 */
export async function antiguedad(tenantId: string, hoy = hoyCR()) {
  const lado = async (
    tabla: 'accounts_receivable' | 'accounts_payable',
    nombreCampo: string,
  ) => {
    const vacio = { total: 0, tramos: {} as Record<string, number>, partes: [] as any[], disponible: true, cuantas: 0 };
    for (const t of TRAMOS) vacio.tramos[t.id] = 0;
    try {
      const { data, error } = await db.from(tabla)
        .select('*').eq('tenant_id', tenantId).neq('status', 'paid').limit(10000);
      if (error) throw error;
      const porParte = new Map<string, { nombre: string; total: number; tramos: Record<string, number>; docs: number; mas_viejo: number }>();
      for (const r of ((data ?? []) as any[])) {
        const saldo = c2(Number(r.total_amount) - Number(r.paid_amount));
        if (saldo <= 0) continue;
        const dias = diasDeAtraso(r.due_date, hoy);
        const tramo = tramoDe(dias);
        vacio.total = c2(vacio.total + saldo);
        vacio.tramos[tramo] = c2(vacio.tramos[tramo] + saldo);
        vacio.cuantas++;
        const nombre = String(r[nombreCampo] ?? 'Sin nombre');
        const clave = String(r.customer_id ?? r.supplier_id ?? nombre);
        const p = porParte.get(clave) ?? {
          nombre, total: 0, tramos: Object.fromEntries(TRAMOS.map(t => [t.id, 0])), docs: 0, mas_viejo: 0,
        };
        p.total = c2(p.total + saldo);
        p.tramos[tramo] = c2(p.tramos[tramo] + saldo);
        p.docs++;
        p.mas_viejo = Math.max(p.mas_viejo, dias);
        porParte.set(clave, p);
      }
      vacio.partes = [...porParte.values()].sort((a, b) => b.mas_viejo - a.mas_viejo || b.total - a.total);
      return vacio;
    } catch (e) {
      if (sinTabla(e)) return { ...vacio, disponible: false };
      throw e;
    }
  };

  return {
    hoy,
    tramos: TRAMOS.map(t => ({ id: t.id, label: t.label })),
    cobrar: await lado('accounts_receivable', 'customer_name'),
    pagar: await lado('accounts_payable', 'supplier_name'),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// FLUJO DE CAJA
// ══════════════════════════════════════════════════════════════════════════

/** Las cuentas que SON plata: caja, bancos y las bancarias configuradas. */
async function cuentasDePlata(tenantId: string): Promise<Set<string>> {
  const codes = new Set(['1101', '1102']);
  try {
    const { data } = await db.from('bank_accounts')
      .select('code').eq('tenant_id', tenantId);
    for (const b of ((data ?? []) as any[])) if (b.code) codes.add(String(b.code));
  } catch { /* sin bancos configurados: caja y la 1102 genérica */ }
  return codes;
}

/**
 * FLUJO DE CAJA, del libro diario.
 *
 * ── Cómo se reparte cada asiento ─────────────────────────────────────────
 * Un asiento mueve plata contra una o varias cuentas. Cuando son varias (una
 * venta: caja contra ventas y contra IVA), el movimiento de caja se reparte
 * entre ellas EN PROPORCIÓN a su monto. No es la única forma de repartirlo,
 * pero es la única que no inventa: la suma por categoría da exactamente el
 * movimiento total de caja, y ninguna categoría se lleva plata que no le
 * corresponde.
 *
 * Esto es flujo de caja por el método DIRECTO y sobre lo CONTABILIZADO: una
 * venta de ayer que todavía no tiene asiento no está acá. Es la razón de que
 * la pantalla diga cuántos documentos quedan sin contabilizar.
 */
export async function flujoCaja(tenantId: string, desde: string, hasta: string) {
  const plata = await cuentasDePlata(tenantId);

  const { data: cuentas } = await db.from('chart_accounts')
    .select('code, name, type').eq('tenant_id', tenantId);
  const nombre = new Map(((cuentas ?? []) as any[]).map(x => [x.code, x.name]));
  const tipo = new Map(((cuentas ?? []) as any[]).map(x => [x.code, x.type]));

  /** Saldo de las cuentas de plata ANTES del rango: el punto de partida. */
  let saldoInicial = 0;
  const leerLineas = async (hastaFecha: string, desdeFecha?: string) => {
    let q = db.from('journal_entries')
      .select('id, fecha, descripcion, numero, source_type')
      .eq('tenant_id', tenantId).eq('anulado', false).lte('fecha', hastaFecha);
    if (desdeFecha) q = q.gte('fecha', desdeFecha);
    const { data: asientos, error } = await q;
    if (error) throw error;
    const porId = new Map(((asientos ?? []) as any[]).map(a => [a.id, a]));
    const ids = [...porId.keys()];
    const lineas: any[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data: ls } = await db.from('journal_lines')
        .select('entry_id, code, debe, haber, detalle').in('entry_id', ids.slice(i, i + 200));
      for (const l of ((ls ?? []) as any[])) lineas.push({ ...l, asiento: porId.get(l.entry_id) });
    }
    return lineas;
  };

  try {
    const antes = new Date(`${desde}T00:00:00Z`); antes.setUTCDate(antes.getUTCDate() - 1);
    const previas = await leerLineas(antes.toISOString().slice(0, 10));
    for (const l of previas) {
      if (!plata.has(l.code)) continue;
      saldoInicial = c2(saldoInicial + Number(l.debe) - Number(l.haber));
    }
  } catch (e) { if (!sinTabla(e)) throw e; return { sin_tabla: true } as any; }

  const lineas = await leerLineas(hasta, desde);

  // Agrupar por asiento para poder repartir.
  const porAsiento = new Map<string, any[]>();
  for (const l of lineas) porAsiento.set(l.entry_id, [...(porAsiento.get(l.entry_id) ?? []), l]);

  const categorias = new Map<string, { code: string; name: string; tipo: string; entradas: number; salidas: number }>();
  const porMes = new Map<string, { entradas: number; salidas: number }>();
  const traspasos = { monto: 0, cuantos: 0 };
  let entradas = 0, salidas = 0;

  for (const [, ls] of porAsiento) {
    const dePlata = ls.filter(l => plata.has(l.code));
    if (!dePlata.length) continue;
    const delta = c2(dePlata.reduce((s, l) => s + Number(l.debe) - Number(l.haber), 0));
    const otras = ls.filter(l => !plata.has(l.code));

    const m = String(ls[0]?.asiento?.fecha ?? '').slice(0, 7);
    const mm = porMes.get(m) ?? { entradas: 0, salidas: 0 };

    if (!otras.length || delta === 0) {
      /* Plata contra plata: un depósito de caja al banco. No es entrada ni
         salida del negocio, solo cambió de bolsillo. Se cuenta aparte en vez
         de inflar las dos columnas con el mismo monto. */
      const movido = c2(dePlata.reduce((s, l) => s + Number(l.debe), 0));
      if (movido > 0) { traspasos.monto = c2(traspasos.monto + movido); traspasos.cuantos++; }
      continue;
    }

    if (delta > 0) { entradas = c2(entradas + delta); mm.entradas = c2(mm.entradas + delta); }
    else { salidas = c2(salidas - delta); mm.salidas = c2(mm.salidas - delta); }
    porMes.set(m, mm);

    const pesos = otras.map(l => Math.abs(Number(l.debe) - Number(l.haber)));
    const sumaPesos = pesos.reduce((s, x) => s + x, 0);
    let repartido = 0;
    otras.forEach((l, i) => {
      /* La última se lleva el resto: repartir por proporción deja céntimos
         sueltos, y si se redondean todos por separado la suma por categoría
         ya no da el movimiento de caja. */
      const parte = i === otras.length - 1
        ? c2(Math.abs(delta) - repartido)
        : c2(Math.abs(delta) * (sumaPesos ? pesos[i] / sumaPesos : 1 / otras.length));
      repartido = c2(repartido + parte);
      const k = l.code;
      const cat = categorias.get(k) ?? {
        code: k, name: nombre.get(k) ?? k, tipo: tipo.get(k) ?? '', entradas: 0, salidas: 0,
      };
      if (delta > 0) cat.entradas = c2(cat.entradas + parte);
      else cat.salidas = c2(cat.salidas + parte);
      categorias.set(k, cat);
    });
  }

  /** Documentos del rango que todavía no tienen asiento. El flujo no los ve. */
  let sinContabilizar = 0;
  try {
    const { data } = await db.from('journal_entries')
      .select('source_id').eq('tenant_id', tenantId).eq('source_type', 'venta').eq('anulado', false)
      .gte('fecha', desde).lte('fecha', hasta);
    const conAsiento = new Set(((data ?? []) as any[]).map(x => x.source_id));
    const { data: fs } = await db.from('invoices')
      .select('id, status').eq('tenant_id', tenantId)
      .gte('issued_at', `${desde}T00:00:00Z`).lte('issued_at', `${hasta}T23:59:59.999Z`).limit(20000);
    sinContabilizar = ((fs ?? []) as any[])
      .filter(f => String(f.status) !== 'cancelled' && !conAsiento.has(f.id)).length;
  } catch { /* el informe vale igual */ }

  return {
    desde, hasta,
    saldo_inicial: saldoInicial,
    entradas, salidas,
    neto: c2(entradas - salidas),
    saldo_final: c2(saldoInicial + entradas - salidas),
    traspasos,
    cuentas_de_plata: [...plata].sort().map(code => ({ code, name: nombre.get(code) ?? code })),
    categorias: [...categorias.values()].sort((a, b) =>
      (b.entradas + b.salidas) - (a.entradas + a.salidas)),
    por_mes: [...porMes.entries()].sort().map(([mes, v]) => ({
      mes, entradas: v.entradas, salidas: v.salidas, neto: c2(v.entradas - v.salidas),
    })),
    ventas_sin_asiento: sinContabilizar,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// ACTIVOS FIJOS Y DEPRECIACIÓN
// ══════════════════════════════════════════════════════════════════════════

const CUENTA_POR_CATEGORIA: Record<string, string> = {
  mobiliario: '1201', computo: '1202', vehiculo: '1203', maquinaria: '1204',
};

/** Cuota mensual en línea recta. */
const cuotaMensual = (a: any) =>
  c2((Number(a.costo) - Number(a.valor_residual)) / Math.max(1, Number(a.vida_meses)));

export async function listaActivos(tenantId: string) {
  const { data, error } = await db.from('fixed_assets')
    .select('*').eq('tenant_id', tenantId).order('fecha_compra', { ascending: false });
  if (error) {
    if (sinTabla(error)) return { sin_tabla: true, activos: [], totales: null };
    throw new Error(error.message);
  }
  const ids = ((data ?? []) as any[]).map(a => a.id);
  const acum = new Map<string, { monto: number; meses: number; ultimo: string }>();
  if (ids.length) {
    const { data: deps } = await db.from('fixed_asset_depreciation')
      .select('asset_id, monto, periodo').in('asset_id', ids);
    for (const d of ((deps ?? []) as any[])) {
      const a = acum.get(d.asset_id) ?? { monto: 0, meses: 0, ultimo: '' };
      a.monto = c2(a.monto + Number(d.monto));
      a.meses++;
      if (d.periodo > a.ultimo) a.ultimo = d.periodo;
      acum.set(d.asset_id, a);
    }
  }

  const activos = ((data ?? []) as any[]).map(a => {
    const dep = acum.get(a.id) ?? { monto: 0, meses: 0, ultimo: '' };
    const depreciable = c2(Number(a.costo) - Number(a.valor_residual));
    return {
      ...a,
      cuota: cuotaMensual(a),
      depreciable,
      depreciado: dep.monto,
      meses_corridos: dep.meses,
      ultimo_periodo: dep.ultimo || null,
      /** Valor en libros: lo que vale hoy según la contabilidad. */
      valor_libros: c2(Number(a.costo) - dep.monto),
      /** Si ya se depreció por completo: la cuota siguiente sería cero. */
      agotado: dep.monto >= depreciable - 0.01,
    };
  });

  return {
    activos,
    totales: {
      costo: c2(activos.reduce((s, a) => s + Number(a.costo), 0)),
      depreciado: c2(activos.reduce((s, a) => s + a.depreciado, 0)),
      valor_libros: c2(activos.reduce((s, a) => s + a.valor_libros, 0)),
      activos: activos.filter(a => !a.baja_fecha).length,
      de_baja: activos.filter(a => a.baja_fecha).length,
    },
  };
}

export async function crearActivo(tenantId: string, userId: string, b: any) {
  const nombre = String(b?.nombre ?? '').trim();
  const costo = c2(b?.costo);
  const vida = Math.round(Number(b?.vida_meses) || 0);
  const residual = c2(b?.valor_residual);
  const categoria = String(b?.categoria ?? 'otro');

  if (!nombre) throw new Error('Ponele un nombre al activo.');
  if (costo <= 0) throw new Error('El costo tiene que ser mayor que cero.');
  if (vida < 1) throw new Error('La vida útil tiene que ser de al menos un mes.');
  if (residual < 0) throw new Error('El valor residual no puede ser negativo.');
  if (residual >= costo) {
    throw new Error('El valor residual es igual o mayor que el costo: así no hay nada que depreciar.');
  }
  const fecha = String(b?.fecha_compra ?? '').slice(0, 10) || hoyCR();

  const cuentaActivo = String(b?.cuenta_activo ?? '') || CUENTA_POR_CATEGORIA[categoria] || '1201';
  await asegurarCuentas(tenantId, [cuentaActivo, '1290', '5208']);

  const { data, error } = await db.from('fixed_assets').insert({
    tenant_id: tenantId, nombre, categoria, fecha_compra: fecha,
    costo, valor_residual: residual, vida_meses: vida,
    cuenta_activo: cuentaActivo, cuenta_acum: '1290', cuenta_gasto: '5208',
    notas: String(b?.notas ?? '').trim() || null,
    created_by: userId,
  }).select('*').single();
  if (error) throw new Error(error.message);
  return data;
}

export async function darDeBajaActivo(tenantId: string, id: string, b: any) {
  const { data: a } = await db.from('fixed_assets')
    .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
  if (!a) throw new Error('Activo no encontrado');
  if ((a as any).baja_fecha) throw new Error('Ese activo ya está dado de baja.');
  const fecha = String(b?.fecha ?? '').slice(0, 10) || hoyCR();
  const { error } = await db.from('fixed_assets')
    .update({ baja_fecha: fecha, baja_motivo: String(b?.motivo ?? '').trim() || null })
    .eq('id', id).eq('tenant_id', tenantId);
  if (error) throw new Error(error.message);
  /* La baja NO genera asiento todavía. Darlo de baja en la ficha y sacarlo
     del balance son dos cosas: la segunda necesita saber si se vendió y por
     cuánto, y eso se registra como venta o como ajuste. Decirlo es mejor que
     hacer un asiento a medias. */
  return { ok: true, nota: 'El activo queda marcado de baja y deja de depreciarse. El retiro del balance se asienta aparte, según si se vendió o se descartó.' };
}

/**
 * CORRER LA DEPRECIACIÓN DE UN MES.
 *
 * Un solo asiento con una línea por activo: así el mayor de la 5208 muestra
 * qué equipo aportó cuánto, en vez de un monto global imposible de explicar.
 *
 * ── Por qué se reclama el periodo ANTES de hacer el asiento ──────────────
 * El único de (activo, periodo) es la defensa contra correrla dos veces. Si
 * primero se hiciera el asiento y después las filas, un doble clic dejaría
 * dos asientos y una sola fila: el gasto duplicado y sin rastro de por qué.
 */
export async function depreciarMes(tenantId: string, periodo: string, userId: string) {
  if (!/^\d{4}-\d{2}$/.test(periodo)) throw new Error('El periodo va como YYYY-MM.');
  const fin = finDeMes(periodo);
  if (fin > hoyCR()) throw new Error(`El mes ${periodo} todavía no termina: su depreciación se corre al cierre del mes.`);

  const { data: activos, error } = await db.from('fixed_assets')
    .select('*').eq('tenant_id', tenantId);
  if (error) {
    if (sinTabla(error)) throw new Error('Falta correr la migración 148_contabilidad_ramas.sql.');
    throw new Error(error.message);
  }

  const ids = ((activos ?? []) as any[]).map(a => a.id);
  const yaAcum = new Map<string, number>();
  const yaEsteMes = new Set<string>();
  if (ids.length) {
    const { data: deps } = await db.from('fixed_asset_depreciation')
      .select('asset_id, monto, periodo').in('asset_id', ids);
    for (const d of ((deps ?? []) as any[])) {
      yaAcum.set(d.asset_id, c2((yaAcum.get(d.asset_id) ?? 0) + Number(d.monto)));
      if (d.periodo === periodo) yaEsteMes.add(d.asset_id);
    }
  }

  const candidatos: Array<{ a: any; monto: number }> = [];
  const saltados: string[] = [];
  for (const a of ((activos ?? []) as any[])) {
    if (yaEsteMes.has(a.id)) { saltados.push(`${a.nombre}: ya tenía ${periodo}`); continue; }
    if (String(a.fecha_compra).slice(0, 7) > periodo) continue;   // comprado después
    if (a.baja_fecha && String(a.baja_fecha).slice(0, 7) < periodo) continue;
    const depreciable = c2(Number(a.costo) - Number(a.valor_residual));
    const acumulado = yaAcum.get(a.id) ?? 0;
    const falta = c2(depreciable - acumulado);
    if (falta <= 0) { saltados.push(`${a.nombre}: ya está depreciado por completo`); continue; }
    /* La última cuota es el resto, no la cuota llena: si no, el activo se
       deprecia por debajo de su valor residual y el balance queda con un
       equipo valiendo menos de lo que se espera recibir por él. */
    const monto = Math.min(cuotaMensual(a), falta);
    if (monto <= 0) continue;
    candidatos.push({ a, monto: c2(monto) });
  }

  if (!candidatos.length) {
    return { periodo, asiento: null, activos: 0, monto: 0, saltados };
  }

  // 1) Reclamar el periodo. Si otro proceso ya lo hizo, el único avisa.
  const { data: filas, error: errClaim } = await db.from('fixed_asset_depreciation').insert(
    candidatos.map(x => ({
      tenant_id: tenantId, asset_id: x.a.id, periodo, monto: x.monto,
    })),
  ).select('id');
  if (errClaim) {
    if (/duplicate|unique/i.test(errClaim.message)) {
      throw new Error(`La depreciación de ${periodo} ya se corrió (o se estaba corriendo). Recargá para ver el asiento.`);
    }
    throw new Error(errClaim.message);
  }
  const filaIds = ((filas ?? []) as any[]).map(f => f.id);

  // 2) El asiento.
  try {
    const total = c2(candidatos.reduce((s, x) => s + x.monto, 0));
    await asegurarCuentas(tenantId, ['1290', '5208']);
    const asiento = await crearAsiento({
      tenantId, userId, fecha: fin,
      descripcion: `Depreciación de ${periodo}`,
      lineas: [
        ...candidatos.map(x => ({
          code: String(x.a.cuenta_gasto ?? '5208'), debe: x.monto,
          detalle: `Depreciación · ${x.a.nombre}`,
        })),
        { code: '1290', haber: total, detalle: 'Depreciación acumulada' },
      ],
      sourceType: 'depreciacion',
    });
    await db.from('fixed_asset_depreciation')
      .update({ entry_id: asiento.id }).in('id', filaIds);
    return { periodo, asiento, activos: candidatos.length, monto: total, saltados };
  } catch (e: any) {
    // Sin asiento no hay depreciación: se suelta el periodo reclamado.
    await db.from('fixed_asset_depreciation').delete().in('id', filaIds);
    throw new Error(e?.message ?? 'No se pudo asentar la depreciación');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CIERRE DE PERIODO
// ══════════════════════════════════════════════════════════════════════════

/** Saldos de ingresos y gastos de un rango, SIN los asientos de cierre. */
async function resultadoDelRango(tenantId: string, desde: string, hasta: string) {
  const { data: cuentas } = await db.from('chart_accounts')
    .select('code, name, type, postable').eq('tenant_id', tenantId);
  const porCodigo = new Map(((cuentas ?? []) as any[]).map(x => [x.code, x]));

  const { data: asientos, error } = await db.from('journal_entries')
    .select('id').eq('tenant_id', tenantId).eq('anulado', false)
    .gte('fecha', desde).lte('fecha', hasta);
  if (error) throw new Error(error.message);
  /* Los asientos de cierre se excluyen: si no, cerrar marzo deja el estado
     de resultados de marzo en cero y el informe que se presentó no se puede
     volver a sacar. */
  const { data: cierres } = await db.from('journal_entries')
    .select('id').eq('tenant_id', tenantId).eq('source_type', 'cierre');
  const esCierre = new Set(((cierres ?? []) as any[]).map(x => x.id));
  const ids = ((asientos ?? []) as any[]).map(a => a.id).filter(id => !esCierre.has(id));

  const acum = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: ls } = await db.from('journal_lines')
      .select('code, debe, haber').in('entry_id', ids.slice(i, i + 200));
    for (const l of ((ls ?? []) as any[])) {
      const cu = porCodigo.get(l.code);
      if (!cu || (cu.type !== 'ingreso' && cu.type !== 'gasto')) continue;
      const signo = cu.type === 'gasto' ? 1 : -1;      // gasto suma por debe
      acum.set(l.code, c2((acum.get(l.code) ?? 0) + signo * (Number(l.debe) - Number(l.haber))));
    }
  }

  const filas = [...acum.entries()]
    .filter(([, saldo]) => Math.abs(saldo) >= 0.01)
    .map(([code, saldo]) => ({
      code, name: porCodigo.get(code)?.name ?? code,
      type: porCodigo.get(code)?.type as string, saldo,
    }));

  const ingresos = c2(filas.filter(f => f.type === 'ingreso').reduce((s, f) => s + f.saldo, 0));
  const gastos = c2(filas.filter(f => f.type === 'gasto').reduce((s, f) => s + f.saldo, 0));
  return { filas, ingresos, gastos, utilidad: c2(ingresos - gastos) };
}

/** Qué pasaría si se cerrara: para mostrarlo antes de apretar el botón. */
export async function previoCierre(tenantId: string, periodo: string) {
  if (!/^\d{4}-\d{2}$/.test(periodo)) throw new Error('El periodo va como YYYY-MM.');
  const r = await resultadoDelRango(tenantId, inicioDeMes(periodo), finDeMes(periodo));
  return { periodo, ...r, fecha_asiento: finDeMes(periodo) };
}

export async function listaPeriodos(tenantId: string) {
  const { data, error } = await db.from('accounting_periods')
    .select('*').eq('tenant_id', tenantId).order('periodo', { ascending: false });
  if (error) {
    if (sinTabla(error)) return { sin_tabla: true, periodos: [] };
    throw new Error(error.message);
  }
  return { periodos: data ?? [] };
}

/**
 * CERRAR UN MES.
 *
 * Manda el resultado del mes a resultados acumulados y deja el mes sin
 * recibir asientos nuevos. Las dos cosas van juntas: cerrar sin trabar la
 * fecha es un asiento decorativo, porque el informe cambia igual mañana.
 */
export async function cerrarPeriodo(tenantId: string, periodo: string, userId: string) {
  if (!/^\d{4}-\d{2}$/.test(periodo)) throw new Error('El periodo va como YYYY-MM.');
  const fin = finDeMes(periodo);
  if (fin > hoyCR()) throw new Error(`El mes ${periodo} todavía no termina: no se puede cerrar.`);

  const r = await resultadoDelRango(tenantId, inicioDeMes(periodo), fin);
  if (!r.filas.length) {
    throw new Error(`No hay ingresos ni gastos registrados en ${periodo}: no hay nada que cerrar.`);
  }

  await asegurarCuentas(tenantId, ['3102']);

  // 1) Reclamar el periodo: el único de (tenant, periodo) evita el doble cierre.
  const { data: fila, error: errClaim } = await db.from('accounting_periods').insert({
    tenant_id: tenantId, periodo,
    utilidad: r.utilidad, ingresos: r.ingresos, gastos: r.gastos,
    cerrado_por: userId,
  }).select('id').single();
  if (errClaim) {
    if (sinTabla(errClaim)) throw new Error('Falta correr la migración 148_contabilidad_ramas.sql.');
    if (/duplicate|unique/i.test(errClaim.message)) throw new Error(`El periodo ${periodo} ya está cerrado.`);
    throw new Error(errClaim.message);
  }

  // 2) El asiento de cierre.
  try {
    const lineas = r.filas.map(f => (
      /* Se cancela cada cuenta contra su propio saldo: una cuenta de ingreso
         con saldo de haber se cierra por el debe, y al revés si quedó en
         negativo (una devolución mayor que la venta del mes). */
      f.type === 'ingreso'
        ? (f.saldo >= 0
          ? { code: f.code, debe: f.saldo, detalle: `Cierre ${periodo} · ${f.name}` }
          : { code: f.code, haber: c2(-f.saldo), detalle: `Cierre ${periodo} · ${f.name}` })
        : (f.saldo >= 0
          ? { code: f.code, haber: f.saldo, detalle: `Cierre ${periodo} · ${f.name}` }
          : { code: f.code, debe: c2(-f.saldo), detalle: `Cierre ${periodo} · ${f.name}` })
    ));
    lineas.push(r.utilidad >= 0
      ? { code: '3102', haber: r.utilidad, detalle: `Utilidad de ${periodo}` }
      : { code: '3102', debe: c2(-r.utilidad), detalle: `Pérdida de ${periodo}` });

    const asiento = await crearAsiento({
      tenantId, userId, fecha: fin,
      descripcion: `Cierre de ${periodo}`,
      lineas, sourceType: 'cierre',
      ignorarCierre: true,
    });
    await db.from('accounting_periods').update({ entry_id: asiento.id }).eq('id', (fila as any).id);
    return { periodo, asiento, ...r };
  } catch (e: any) {
    await db.from('accounting_periods').delete().eq('id', (fila as any).id);
    throw new Error(e?.message ?? 'No se pudo cerrar el periodo');
  }
}

/**
 * REABRIR UN MES.
 *
 * El asiento de cierre se BORRA, no se anula. Un contra-asiento se fecharía
 * hoy y devolvería los ingresos de marzo al mes en que se reabrió: el estado
 * de resultados de los dos meses quedaría mal. El asiento de cierre no
 * respalda ningún hecho económico —lo generó el sistema a partir de los
 * demás asientos—, así que borrarlo no pierde información: se puede volver a
 * generar idéntico cerrando otra vez.
 */
export async function reabrirPeriodo(tenantId: string, periodo: string) {
  const { data: p } = await db.from('accounting_periods')
    .select('*').eq('tenant_id', tenantId).eq('periodo', periodo).maybeSingle();
  if (!p) throw new Error(`El periodo ${periodo} no está cerrado.`);
  // Primero se suelta el candado: si no, borrar el asiento no se puede.
  const { error } = await db.from('accounting_periods')
    .delete().eq('id', (p as any).id);
  if (error) throw new Error(error.message);
  if ((p as any).entry_id) {
    await db.from('journal_entries').delete()
      .eq('id', (p as any).entry_id).eq('tenant_id', tenantId);
  }
  return { periodo, reabierto: true };
}
