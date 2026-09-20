import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { nextInvoiceNumber } from './invoices.js';

/**
 * VENTAS SIN SISTEMA: cargar a mano lo vendido un día que no se usó el POS.
 *
 * Pasa seguido: se fue la luz, se cayó internet y no se pudo ni abrir el POS, o
 * el negocio arrancó a mitad de mes y las primeras semanas se cobraron en un
 * cuaderno. Esa plata existió, pero para el sistema ese día está en cero: los
 * reportes muestran un hueco, el mes no cuadra con el banco y la declaración
 * queda corta.
 *
 * Acá se carga el TOTAL del día por medio de pago (efectivo, tarjeta, SINPE) y
 * se guarda como ventas con la FECHA de ese día. No pretende reconstruir cada
 * venta —no existe ese detalle— sino que el día deje de estar vacío.
 *
 * Qué NO hace, a propósito:
 *  · no toca el inventario: no se sabe qué se vendió;
 *  · no emite nada a Hacienda: un comprobante electrónico se emite cuando se
 *    hace la venta, no después;
 *  · no entra al cierre de caja de hoy: es de otro día, y meterlo en el arqueo
 *    de hoy inventaría un sobrante.
 */
const manualSales = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/** Marca en las notas para reconocer estas ventas y poder listarlas o borrarlas. */
const MARCA = '[VENTA SIN SISTEMA]';

const CargaSchema = z.object({
  /** Día de la venta, en formato AAAA-MM-DD. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va como AAAA-MM-DD'),
  cash:  z.number().nonnegative().optional().default(0),
  card:  z.number().nonnegative().optional().default(0),
  sinpe: z.number().nonnegative().optional().default(0),
  /** Otros medios (transferencia, cheque…), opcional. */
  other: z.number().nonnegative().optional().default(0),
  notes: z.string().max(300).optional().nullable(),
  /** Cantidad de ventas del día, si se sabe. Solo informativo. */
  count: z.number().int().nonnegative().optional().nullable(),
});

const r2 = (n: number) => Math.round(Number(n || 0) * 100) / 100;

/** Medio de pago → etiqueta para la nota y el detalle. */
const NOMBRE: Record<string, string> = {
  cash: 'Efectivo', card: 'Tarjeta', sinpe: 'SINPE', other: 'Otros medios',
};

/**
 * Hora del día en Costa Rica, guardada como "reloj de pared" (sin zona), igual
 * que las ventas del POS. Se usa el mediodía para que ningún ajuste de horario
 * la corra al día anterior o al siguiente.
 */
const aMediodia = (fecha: string) => `${fecha}T12:00:00`;

// GET / — días ya cargados a mano. ?from=&to= para filtrar.
manualSales.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    let q = db.from('invoices')
      .select('id, invoice_number, issued_at, payment_method, total, notes, status')
      .eq('tenant_id', tenantId).like('notes', `${MARCA}%`)
      .order('issued_at', { ascending: false });
    const desde = c.req.query('from');
    const hasta = c.req.query('to');
    if (desde) q = q.gte('issued_at', `${desde}T00:00:00`);
    if (hasta) q = q.lte('issued_at', `${hasta}T23:59:59`);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    // Una fila por DÍA: es como se cargó y como se entiende.
    const porDia = new Map<string, any>();
    for (const inv of (data ?? []) as any[]) {
      if (inv.status === 'cancelled') continue;
      const dia = String(inv.issued_at ?? '').slice(0, 10);
      const fila = porDia.get(dia) ?? {
        date: dia, cash: 0, card: 0, sinpe: 0, other: 0, total: 0,
        invoices: [] as Array<{ id: string; number: string; method: string; total: number }>,
        notes: null as string | null,
      };
      const monto = Number(inv.total ?? 0);
      const metodo = String(inv.payment_method ?? 'other');
      if (metodo === 'cash') fila.cash += monto;
      else if (metodo === 'card') fila.card += monto;
      else if (metodo === 'sinpe') fila.sinpe += monto;
      else fila.other += monto;
      fila.total += monto;
      fila.invoices.push({ id: inv.id, number: inv.invoice_number, method: metodo, total: monto });
      // La nota del usuario va después de la marca.
      const nota = String(inv.notes ?? '').replace(MARCA, '').trim();
      const limpia = nota.replace(/^(Efectivo|Tarjeta|SINPE|Otros medios)( · )?/, '').trim();
      if (limpia && !fila.notes) fila.notes = limpia;
      porDia.set(dia, fila);
    }
    return ok(c, [...porDia.values()].map(f => ({
      ...f, cash: r2(f.cash), card: r2(f.card), sinpe: r2(f.sinpe), other: r2(f.other), total: r2(f.total),
    })));
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * POST / — carga (o REEMPLAZA) el total de un día.
 *
 * Si ese día ya se había cargado, se borra lo anterior y se guarda lo nuevo:
 * corregir un monto mal digitado tiene que ser posible sin terminar con el día
 * contado dos veces. Solo se borra lo que cargó este mismo módulo.
 */
manualSales.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = CargaSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const b = parsed.data;

    const hoy = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
    if (b.date > hoy) {
      return fail(c, 'No se pueden cargar ventas de un día que todavía no llegó.', 422);
    }

    const montos: Array<[string, number]> = [
      ['cash', r2(b.cash)], ['card', r2(b.card)], ['sinpe', r2(b.sinpe)], ['other', r2(b.other)],
    ];
    const conMonto = montos.filter(([, v]) => v > 0);
    if (conMonto.length === 0) {
      return fail(c, 'Poné al menos un monto: efectivo, tarjeta o SINPE.', 422);
    }

    // Lo que ya estuviera cargado de ese día, se reemplaza (ver arriba).
    const { data: previas } = await db.from('invoices')
      .select('id, fe_clave').eq('tenant_id', tenantId).like('notes', `${MARCA}%`)
      .gte('issued_at', `${b.date}T00:00:00`).lte('issued_at', `${b.date}T23:59:59`);
    const idsPrevios = ((previas ?? []) as any[]).filter(p => !p.fe_clave).map(p => p.id);
    let reemplazadas = 0;
    if (idsPrevios.length > 0) {
      await db.from('invoice_items').delete().in('invoice_id', idsPrevios);
      const { error } = await db.from('invoices').delete().in('id', idsPrevios).eq('tenant_id', tenantId);
      if (error) throw new Error(`No se pudo reemplazar lo cargado antes: ${error.message}`);
      reemplazadas = idsPrevios.length;
    }

    const nota = String(b.notes ?? '').trim();
    const creadas: any[] = [];
    for (const [metodo, monto] of conMonto) {
      // Una venta por medio de pago: así el reporte por método cuadra.
      let numero = await nextInvoiceNumber(tenantId);
      let fila: any = null, ultimoError: any = null;
      for (let intento = 0; intento < 6; intento++) {
        const res = await db.from('invoices').insert({
          tenant_id: tenantId,
          invoice_number: numero,
          cash_session_id: null,          // es de otro día: no entra al arqueo de hoy
          customer_name: 'Ventas del día (sin sistema)',
          subtotal: monto, discount_amount: 0, tax_amount: 0, total: monto,
          payment_method: metodo,
          document_type: 'ticket',
          status: 'completed',
          notes: [`${MARCA} ${NOMBRE[metodo] ?? metodo}`, nota].filter(Boolean).join(' · '),
          issued_at: aMediodia(b.date),
        }).select('*').single();
        if (!res.error) { fila = res.data; break; }
        ultimoError = res.error;
        const duplicado = String(res.error.code) === '23505' || /duplicate/i.test(res.error.message ?? '');
        if (!duplicado) break;
        numero = await nextInvoiceNumber(tenantId, intento + 1);
      }
      if (!fila) throw new Error(ultimoError?.message ?? 'No se pudo guardar la venta');

      /**
       * Una línea de detalle, para que la venta no quede vacía.
       *
       * Una factura sin líneas rompe la reimpresión y los reportes por producto.
       * No se sabe qué se vendió, así que la línea dice exactamente eso.
       */
      const item: any = {
        invoice_id: fila.id, product_id: null,
        product_name: `Ventas del día ${b.date} (${NOMBRE[metodo] ?? metodo})`,
        quantity: 1, unit_price: monto, discount_percent: 0, discount_amount: 0, subtotal: monto,
      };
      let { error: itErr } = await db.from('invoice_items').insert(item);
      if (itErr && /product_name/i.test(itErr.message)) {
        const { product_name, ...sinNombre } = item;
        ({ error: itErr } = await db.from('invoice_items').insert(sinNombre));
      }
      if (itErr) console.warn('[ventas sin sistema] línea de detalle:', itErr.message);

      creadas.push({ id: fila.id, number: fila.invoice_number, method: metodo, total: monto });
    }

    const total = r2(conMonto.reduce((s, [, v]) => s + v, 0));
    return ok(c, {
      ok: true, date: b.date, total, creadas, reemplazadas,
      cantidad_ventas: b.count ?? null,
    }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// DELETE /:date — quita lo cargado a mano de ese día (AAAA-MM-DD).
manualSales.delete('/:date', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const fecha = c.req.param('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fail(c, 'La fecha va como AAAA-MM-DD', 422);

    const { data: filas } = await db.from('invoices')
      .select('id, fe_clave').eq('tenant_id', tenantId).like('notes', `${MARCA}%`)
      .gte('issued_at', `${fecha}T00:00:00`).lte('issued_at', `${fecha}T23:59:59`);
    // Por si alguna llegó a emitirse: esas no se borran (ver migración 109).
    const ids = ((filas ?? []) as any[]).filter(f => !f.fe_clave).map(f => f.id);
    if (ids.length === 0) return fail(c, 'Ese día no tiene ventas cargadas a mano.', 404);

    await db.from('invoice_items').delete().in('invoice_id', ids);
    const { error } = await db.from('invoices').delete().in('id', ids).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: ids.length });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default manualSales;
