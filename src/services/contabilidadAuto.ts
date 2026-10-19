import { db } from '../db/client.js';
import { crearAsiento } from './contabilidad.js';

/**
 * ASIENTOS AUTOMÁTICOS: de la operación diaria al libro diario.
 *
 * Nadie va a cargar a mano cuatrocientas ventas al mes. Si la contabilidad
 * depende de que alguien las transcriba, no se lleva — y lo que no se lleva
 * no sirve para decidir ni para presentar.
 *
 * ── Qué pasa cuando falta un dato ────────────────────────────────────────
 * No se inventa. Una venta sin costo registrado se contabiliza igual —el
 * ingreso es un hecho— pero SIN costo de ventas, y el informe avisa cuántas
 * están así. La alternativa, estimar el costo con el precio de hoy, daría un
 * estado de resultados prolijo y falso, y nadie volvería a revisarlo.
 */

const c2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;
const dia = (iso: any) => String(iso ?? '').slice(0, 10);

/**
 * LAS CUENTAS BANCARIAS DEL NEGOCIO, con a qué método atiende cada una.
 *
 * Si no hay ninguna configurada se usa la cuenta genérica 1102, que es lo
 * que había antes: el módulo sigue funcionando sin obligar a configurar
 * nada el primer día.
 */
async function cuentasBancarias(tenantId: string): Promise<Map<string, string>> {
  const porMetodo = new Map<string, string>();
  try {
    const { data } = await db.from('bank_accounts')
      .select('code, metodos').eq('tenant_id', tenantId).eq('activa', true);
    for (const b of ((data ?? []) as any[])) {
      for (const m of (b.metodos ?? [])) porMetodo.set(String(m).toLowerCase(), b.code);
    }
  } catch { /* sin tabla, se usa la genérica */ }
  return porMetodo;
}

/**
 * Dónde cae el dinero según cómo se cobró.
 *
 * `bancos` trae la cuenta específica por método, si el negocio las configuró.
 * Sin configuración, todo lo bancario cae en 1102 como antes.
 */
function cuentaDeCobro(metodo: string, bancos?: Map<string, string>): string {
  const m = String(metodo ?? '').toLowerCase();
  if (/credit|credito|fiado|cuenta/.test(m)) return '1103';   // cuentas por cobrar
  /**
   * La TARJETA no entra al banco el día de la venta.
   *
   * El procesador deposita días después y neto de comisión. Mandarla
   * directo a Bancos ponía plata que todavía no llegó y, peor, hacía
   * desaparecer la comisión: nunca se registraba como gasto. Va a «Tarjetas
   * por liquidar» y de ahí sale cuando el depósito se registra.
   */
  if (/card|tarjeta|datafono|dataphone/.test(m)) return '1106';
  if (/sinpe|transfer|deposito|banco/.test(m)) {
    return bancos?.get(m) ?? '1102';
  }
  return '1101';                                               // caja
}

/**
 * CÓMO SE COBRÓ, de verdad.
 *
 * `payment_method` es una etiqueta y miente en las ventas mixtas: dice
 * «mixed», que no es ninguna cuenta. Medido en una venta real —la 004965—
 * eran ₡2.000 en efectivo y ₡13.850 por SINPE, y el asiento mandaba los
 * ₡15.850 completos a Caja.
 *
 * El desglose está en la columna `payments`, y está en TODAS las ventas, no
 * solo en las mixtas. Esta función lo usa y cae a la etiqueta solo si no hay
 * desglose, que es lo que pasa con las ventas viejas.
 */
function desglosarCobro(v: any): Array<{ metodo: string; monto: number }> {
  const pagos = Array.isArray(v?.payments) ? v.payments : [];
  const limpio = pagos
    .map((p: any) => ({ metodo: String(p?.method ?? p?.metodo ?? ''), monto: c2(p?.amount ?? p?.monto) }))
    .filter((p: any) => p.monto > 0 && p.metodo);
  if (limpio.length === 0) return [{ metodo: String(v?.payment_method ?? ''), monto: c2(v?.total) }];

  /**
   * El desglose tiene que sumar el total.
   *
   * Si no —un vuelto mal guardado, un redondeo—, se ajusta la última línea
   * en vez de descartar el desglose entero: una diferencia de cinco colones
   * no justifica mandar toda la venta a la cuenta equivocada, pero un
   * asiento descuadrado no se puede guardar.
   */
  const suma = c2(limpio.reduce((s: number, p: any) => s + p.monto, 0));
  const total = c2(v?.total);
  if (suma !== total && limpio.length > 0) {
    limpio[limpio.length - 1].monto = c2(limpio[limpio.length - 1].monto + (total - suma));
  }
  return limpio.filter((p: any) => p.monto > 0);
}

/**
 * Una VENTA.
 *
 *   Caja/Bancos/CxC      (debe)  total
 *     Ventas                     (haber) subtotal
 *     IVA cobrado                (haber) impuesto
 *   Costo de ventas      (debe)  costo      ─┐ solo si hay costo registrado
 *     Inventario                 (haber) costo ┘
 */
export async function asentarVenta(tenantId: string, invoiceId: string, userId?: string) {
  const { data: f } = await db.from('invoices')
    .select('id, invoice_number, issued_at, subtotal, tax_amount, total, payment_method, payments, status, customer_name')
    .eq('id', invoiceId).eq('tenant_id', tenantId).maybeSingle();
  if (!f) throw new Error('Factura no encontrada');
  const v: any = f;
  if (String(v.status) === 'cancelled') throw new Error('La factura está anulada: no se contabiliza.');

  const total = c2(v.total);
  const iva = c2(v.tax_amount);
  const neto = c2(total - iva);
  if (total <= 0) throw new Error('La factura es por cero: no hay nada que contabilizar.');

  const bancos = await cuentasBancarias(tenantId);
  const lineas: any[] = [
    // Una línea por forma de cobro: la venta mixta deja de caer entera en
    // una sola cuenta.
    ...desglosarCobro(v).map(p => ({
      code: cuentaDeCobro(p.metodo, bancos),
      debe: p.monto,
      detalle: `Factura ${v.invoice_number ?? ''} · ${p.metodo}`.trim(),
    })),
    { code: '4101', haber: neto, detalle: 'Venta' },
  ];
  if (iva > 0) lineas.push({ code: '2102', haber: iva, detalle: 'IVA cobrado' });

  /**
   * EL COSTO DE VENTAS, si está.
   *
   * Sale de `stock_movements.unit_cost`, que guarda el costo al momento de
   * la salida. El costo de HOY del producto no sirve: lo que se vendió en
   * marzo se vendió al costo de marzo, y usar el actual mueve la ganancia de
   * meses ya cerrados cada vez que cambia un precio de compra.
   */
  let costo = 0;
  try {
    const { data: movs } = await db.from('stock_movements')
      .select('quantity, unit_cost').eq('reference_type', 'invoice').eq('reference_id', invoiceId);
    for (const m of ((movs ?? []) as any[])) {
      if (m.unit_cost == null) continue;
      costo += Math.abs(Number(m.quantity) || 0) * Number(m.unit_cost);
    }
    costo = c2(costo);
  } catch { costo = 0; }

  if (costo > 0) {
    lineas.push({ code: '5101', debe: costo, detalle: 'Costo de lo vendido' });
    lineas.push({ code: '1104', haber: costo, detalle: 'Salida de inventario' });
  }

  return crearAsiento({
    tenantId, fecha: dia(v.issued_at),
    descripcion: `Venta ${v.invoice_number ?? ''}`.trim() + (v.customer_name ? ` · ${v.customer_name}` : ''),
    lineas, sourceType: 'venta', sourceId: invoiceId, userId,
  });
}

/** A qué cuenta de gasto va, según la categoría que ya usa el negocio. */
function cuentaDeGasto(categoria: string): string {
  const t = String(categoria ?? '').toLowerCase();
  if (/salario|planilla|sueldo|ccss/.test(t)) return '5202';
  if (/alquiler|renta|local/.test(t)) return '5203';
  if (/agua|luz|electric|internet|telefon|servicio/.test(t)) return '5204';
  if (/combustible|gasolina|diesel|transporte|peaje|flete/.test(t)) return '5205';
  if (/otro/.test(t)) return '5299';
  return '5201';                                   // gastos generales
}

/**
 * Un GASTO.
 *
 *   Gasto (la cuenta que toque)  (debe)  neto
 *   IVA pagado                   (debe)  impuesto
 *     Caja/Bancos/CxP                    (haber) total
 */
export async function asentarGasto(tenantId: string, expenseId: string, userId?: string) {
  const { data: g } = await db.from('expenses')
    .select('*').eq('id', expenseId).eq('tenant_id', tenantId).maybeSingle();
  if (!g) throw new Error('Gasto no encontrado');
  const e: any = g;

  const total = c2(e.amount);
  if (total <= 0) throw new Error('El gasto es por cero: no hay nada que contabilizar.');
  const iva = c2(e.tax_amount ?? 0);
  const neto = c2(total - iva);

  let categoria = '';
  if (e.category_id) {
    const { data: cat } = await db.from('expense_categories').select('name').eq('id', e.category_id).maybeSingle();
    categoria = String((cat as any)?.name ?? '');
  }

  const lineas: any[] = [
    { code: cuentaDeGasto(categoria), debe: neto, detalle: e.description ?? categoria ?? 'Gasto' },
  ];
  if (iva > 0) lineas.push({ code: '1105', debe: iva, detalle: 'IVA pagado' });
  const bancosG = await cuentasBancarias(tenantId);
  lineas.push({ code: cuentaDeCobro(e.payment_method, bancosG), haber: total, detalle: 'Pago del gasto' });

  return crearAsiento({
    tenantId, fecha: dia(e.date),
    descripcion: `Gasto: ${e.description ?? categoria ?? 'sin descripción'}`,
    lineas, sourceType: 'gasto', sourceId: expenseId, userId,
  });
}

/**
 * Una COMPRA de mercadería.
 *
 *   Inventario    (debe)  neto
 *   IVA pagado    (debe)  impuesto
 *     Cuentas por pagar   (haber) total
 *
 * Va contra cuentas por pagar y no contra caja: una orden de compra es la
 * obligación, no el pago. El pago es otro hecho y tiene su propio asiento.
 */
export async function asentarCompra(tenantId: string, purchaseId: string, userId?: string) {
  const { data: p } = await db.from('purchases')
    .select('*').eq('id', purchaseId).eq('tenant_id', tenantId).maybeSingle();
  if (!p) throw new Error('Compra no encontrada');
  const co: any = p;

  const total = c2(co.total_amount);
  if (total <= 0) throw new Error('La compra es por cero: no hay nada que contabilizar.');
  const iva = c2(co.tax_amount ?? 0);
  const neto = c2(total - iva);

  let proveedor = '';
  if (co.supplier_id) {
    const { data: s } = await db.from('suppliers').select('name').eq('id', co.supplier_id).maybeSingle();
    proveedor = String((s as any)?.name ?? '');
  }

  const lineas: any[] = [{ code: '1104', debe: neto, detalle: 'Mercadería' }];
  if (iva > 0) lineas.push({ code: '1105', debe: iva, detalle: 'IVA pagado' });
  lineas.push({ code: '2101', haber: total, detalle: proveedor || 'Proveedor' });

  return crearAsiento({
    tenantId, fecha: dia(co.purchase_date),
    descripcion: `Compra ${co.purchase_number ?? ''}`.trim() + (proveedor ? ` · ${proveedor}` : ''),
    lineas, sourceType: 'compra', sourceId: purchaseId, userId,
  });
}

/**
 * CONTABILIZAR TODO LO QUE FALTE de un período.
 *
 * Por tandas y con presupuesto de tiempo: la función del servidor se corta a
 * los treinta segundos y un mes puede traer cientos de documentos. Lo que no
 * entra queda para la próxima corrida; el índice único por documento impide
 * que algo se contabilice dos veces.
 */
export async function asentarPendientes(opts: {
  tenantId: string; desde: string; hasta: string; presupuestoMs?: number; userId?: string;
}) {
  const hasta = Date.now() + (opts.presupuestoMs ?? 18_000);
  const salida = { ventas: 0, gastos: 0, compras: 0, saltados: 0, errores: [] as string[], faltan: 0 };

  const yaHecho = async (tipo: string) => {
    const { data } = await db.from('journal_entries')
      .select('source_id').eq('tenant_id', opts.tenantId).eq('source_type', tipo).eq('anulado', false);
    return new Set(((data ?? []) as any[]).map(x => x.source_id));
  };

  const trabajos: Array<[string, any[], (id: string) => Promise<any>, keyof typeof salida]> = [];

  const { data: ventas } = await db.from('invoices')
    .select('id').eq('tenant_id', opts.tenantId).neq('status', 'cancelled')
    .gte('issued_at', `${opts.desde}T00:00:00`).lte('issued_at', `${opts.hasta}T23:59:59`).limit(2000);
  trabajos.push(['venta', (ventas ?? []) as any[], (id) => asentarVenta(opts.tenantId, id, opts.userId), 'ventas']);

  const { data: gastos } = await db.from('expenses')
    .select('id').eq('tenant_id', opts.tenantId)
    .gte('date', opts.desde).lte('date', opts.hasta).limit(2000);
  trabajos.push(['gasto', (gastos ?? []) as any[], (id) => asentarGasto(opts.tenantId, id, opts.userId), 'gastos']);

  const { data: compras } = await db.from('purchases')
    .select('id').eq('tenant_id', opts.tenantId)
    .gte('purchase_date', opts.desde).lte('purchase_date', opts.hasta).limit(2000);
  trabajos.push(['compra', (compras ?? []) as any[], (id) => asentarCompra(opts.tenantId, id, opts.userId), 'compras']);

  for (const [tipo, filas, fn, clave] of trabajos) {
    const hechos = await yaHecho(tipo);
    for (const f of filas) {
      if (hechos.has(f.id)) { salida.saltados += 1; continue; }
      if (Date.now() > hasta) { salida.faltan += 1; continue; }
      try { await fn(f.id); (salida[clave] as number) += 1; }
      catch (e: any) {
        if (/ya tiene asiento/.test(e?.message ?? '')) { salida.saltados += 1; continue; }
        if (salida.errores.length < 10) salida.errores.push(`${tipo} ${f.id.slice(0, 8)}: ${e?.message}`);
      }
    }
  }
  return salida;
}
