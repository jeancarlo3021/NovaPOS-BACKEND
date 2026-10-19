import { db } from '../db/client.js';
import { crearAsiento } from './contabilidad.js';

/**
 * EL CIRCUITO DEL DINERO: bancos, tarjetas y caja.
 *
 * Todo lo que mueve plata entre cuentas sin que haya una venta o un gasto de
 * por medio: el depósito del efectivo, la liquidación del procesador de
 * tarjetas, el faltante del cierre. Son los movimientos que nadie registra
 * porque «no son una operación», y son justamente los que hacen que el saldo
 * contable y el del banco dejen de parecerse.
 */

const c2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;
const hoyCR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });

/** Crea la cuenta contable de un banco y devuelve su código. */
export async function crearCuentaBancaria(tenantId: string, datos: {
  nombre: string; banco?: string; numero?: string; moneda?: string; metodos?: string[];
}) {
  /**
   * El código sale del siguiente libre bajo 1102.
   *
   * 1102-01, 1102-02… Se calcula mirando las que ya existen en vez de
   * contarlas: si alguna se borró, contar daría un código repetido y el
   * índice único lo rechazaría sin explicar por qué.
   */
  const { data: previas } = await db.from('bank_accounts')
    .select('code').eq('tenant_id', tenantId);
  const usados = new Set(((previas ?? []) as any[]).map(x => String(x.code)));
  let n = 1;
  while (usados.has(`1102-${String(n).padStart(2, '0')}`)) n += 1;
  const code = `1102-${String(n).padStart(2, '0')}`;

  const nombre = String(datos.nombre ?? '').trim() || 'Cuenta bancaria';
  const { error: errC } = await db.from('chart_accounts').insert({
    tenant_id: tenantId, code, name: `Banco: ${nombre}`, type: 'activo', postable: true,
  });
  if (errC && !/duplicate|unique/i.test(errC.message)) throw new Error(errC.message);

  const { data, error } = await db.from('bank_accounts').insert({
    tenant_id: tenantId, nombre, banco: datos.banco ?? null, numero: datos.numero ?? null,
    moneda: datos.moneda ?? 'CRC', code,
    metodos: (datos.metodos ?? []).map(m => String(m).toLowerCase()),
  }).select('*').single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * DEPÓSITO: el efectivo de la caja va al banco.
 *
 *   Banco   (debe)  monto
 *     Caja          (haber) monto
 *
 * Sin este asiento, Caja crece sin parar en los libros mientras el efectivo
 * real ya está en el banco, y los dos saldos dejan de significar algo.
 */
export async function asentarDeposito(opts: {
  tenantId: string; bankAccountId: string; monto: number; fecha?: string;
  referencia?: string; userId?: string;
}) {
  const monto = c2(opts.monto);
  if (monto <= 0) throw new Error('El depósito tiene que ser mayor que cero');
  const { data: cta } = await db.from('bank_accounts')
    .select('code, nombre').eq('id', opts.bankAccountId).eq('tenant_id', opts.tenantId).maybeSingle();
  if (!cta) throw new Error('Cuenta bancaria no encontrada');

  return crearAsiento({
    tenantId: opts.tenantId, userId: opts.userId,
    fecha: opts.fecha || hoyCR(),
    descripcion: `Depósito a ${(cta as any).nombre}`
      + (opts.referencia ? ` · ${opts.referencia}` : ''),
    lineas: [
      { code: (cta as any).code, debe: monto, detalle: 'Depósito' },
      { code: '1101', haber: monto, detalle: 'Salida de caja' },
    ],
    sourceType: 'deposito',
  });
}

/**
 * LIQUIDACIÓN DE TARJETAS: lo que el procesador deposita.
 *
 *   Banco                (debe)  neto
 *   Comisiones bancarias (debe)  comisión
 *     Tarjetas por liquidar      (haber) bruto
 *
 * Es el asiento que hacía falta para que la comisión exista en los libros.
 * Medido: unos ₡107.600 al mes que hoy no aparecen en ningún estado de
 * resultados, y un saldo bancario inflado mientras el depósito no llega.
 */
export async function asentarLiquidacion(opts: {
  tenantId: string; bankAccountId?: string; bruto: number; comision: number;
  fecha?: string; referencia?: string; userId?: string;
}) {
  const bruto = c2(opts.bruto);
  const comision = c2(opts.comision);
  const neto = c2(bruto - comision);
  if (bruto <= 0) throw new Error('El monto bruto tiene que ser mayor que cero');
  if (comision < 0) throw new Error('La comisión no puede ser negativa');
  if (neto < 0) throw new Error('La comisión no puede ser mayor que el bruto');

  let code = '1102';
  let nombre = 'Bancos';
  if (opts.bankAccountId) {
    const { data: cta } = await db.from('bank_accounts')
      .select('code, nombre').eq('id', opts.bankAccountId).eq('tenant_id', opts.tenantId).maybeSingle();
    if (cta) { code = (cta as any).code; nombre = (cta as any).nombre; }
  }

  const { data: fila, error } = await db.from('card_settlements').insert({
    tenant_id: opts.tenantId, fecha: opts.fecha || hoyCR(),
    bank_account_id: opts.bankAccountId ?? null,
    bruto, comision, neto, referencia: opts.referencia ?? null,
  }).select('id').single();
  if (error) throw new Error(error.message);

  const lineas: any[] = [{ code, debe: neto, detalle: `Depósito del procesador en ${nombre}` }];
  if (comision > 0) lineas.push({ code: '5206', debe: comision, detalle: 'Comisión del procesador' });
  lineas.push({ code: '1106', haber: bruto, detalle: 'Tarjetas liquidadas' });

  const asiento = await crearAsiento({
    tenantId: opts.tenantId, userId: opts.userId,
    fecha: opts.fecha || hoyCR(),
    descripcion: `Liquidación de tarjetas${opts.referencia ? ` · ${opts.referencia}` : ''}`,
    lineas, sourceType: 'liquidacion', sourceId: (fila as any).id,
  });
  return { ...asiento, bruto, comision, neto };
}

/**
 * EL FALTANTE O SOBRANTE DEL CIERRE DE CAJA.
 *
 * Lo esperado sale de la apertura más los cobros en efectivo del turno menos
 * las salidas. La diferencia contra lo contado se guarda y se contabiliza:
 *   faltante → gasto; sobrante → ingreso.
 *
 * Sin esto, la caja contable nunca coincide con el arqueo y la diferencia se
 * arrastra para siempre sin que nadie sepa de qué día viene.
 */
export async function cerrarCajaContable(opts: {
  tenantId: string; sessionId: string; contado: number; userId?: string;
}) {
  const { data: ses } = await db.from('cash_sessions')
    .select('*').eq('id', opts.sessionId).eq('tenant_id', opts.tenantId).maybeSingle();
  if (!ses) throw new Error('Sesión de caja no encontrada');
  const s: any = ses;

  /** Lo que la caja DEBERÍA tener: apertura + efectivo cobrado − salidas. */
  const { data: ventas } = await db.from('invoices')
    .select('total, payment_method, payments').eq('cash_session_id', opts.sessionId);
  let efectivo = 0;
  for (const v of ((ventas ?? []) as any[])) {
    const pagos = Array.isArray(v.payments) ? v.payments : [];
    if (pagos.length) {
      for (const p of pagos) {
        if (/cash|efectivo/i.test(String(p?.method ?? p?.metodo ?? ''))) efectivo += Number(p?.amount ?? p?.monto ?? 0);
      }
    } else if (/cash|efectivo/i.test(String(v.payment_method ?? ''))) {
      efectivo += Number(v.total ?? 0);
    }
  }
  let salidas = 0;
  try {
    const { data: movs } = await db.from('cash_movements')
      .select('type, amount').eq('cash_session_id', opts.sessionId);
    for (const m of ((movs ?? []) as any[])) {
      if (/expense|salida|retiro/i.test(String(m.type))) salidas += Number(m.amount ?? 0);
    }
  } catch { /* sin movimientos, solo ventas */ }

  const esperado = c2(Number(s.opening_amount ?? 0) + efectivo - salidas);
  const contado = c2(opts.contado);
  const diferencia = c2(contado - esperado);

  await db.from('cash_sessions').update({
    expected_amount: esperado, difference: diferencia,
    closing_amount: contado, closing_date: new Date().toISOString(), status: 'closed',
  }).eq('id', opts.sessionId);

  let asiento = null;
  if (Math.abs(diferencia) >= 1) {
    // Faltante: sale plata de la caja contra un gasto. Sobrante, al revés.
    asiento = await crearAsiento({
      tenantId: opts.tenantId, userId: opts.userId, fecha: hoyCR(),
      descripcion: diferencia < 0
        ? `Faltante en el cierre de caja (${c2(Math.abs(diferencia))})`
        : `Sobrante en el cierre de caja (${diferencia})`,
      lineas: diferencia < 0
        ? [{ code: '5207', debe: Math.abs(diferencia), detalle: 'Faltante' },
           { code: '1101', haber: Math.abs(diferencia), detalle: 'Ajuste de caja' }]
        : [{ code: '1101', debe: diferencia, detalle: 'Ajuste de caja' },
           { code: '5207', haber: diferencia, detalle: 'Sobrante' }],
      sourceType: 'cierre_caja', sourceId: opts.sessionId,
    });
  }
  return { esperado, contado, diferencia, asiento };
}
