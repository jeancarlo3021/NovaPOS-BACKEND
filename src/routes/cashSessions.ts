import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { endOfDay } from '../utils/dateRange.js';

const cashSessions = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// Schema matches actual DB: opening_amount, status='open'/'closed'
const OpenSchema  = z.object({
  opening_amount: z.number().nonnegative(),
  opening_usd: z.number().nonnegative().optional(),   // dólares contados en apertura
  notes: z.string().optional().nullable(),
  /**
   * LA MÁQUINA que abre la caja.
   *
   * Una caja es una gaveta con plata, no una persona: lo que la identifica es
   * el equipo que la opera (el mismo número de terminal del consecutivo de
   * Hacienda). Cuando llega, la caja es de la MÁQUINA: cualquier cajero que
   * entre en ese equipo sigue la caja que está abierta, y dos equipos tienen
   * dos cajas aunque los atienda la misma persona.
   *
   * Si no llega, todo se comporta como antes: una caja por usuario.
   */
  terminal: z.number().int().min(1).max(99999).optional().nullable(),
  caja_nombre: z.string().max(60).optional().nullable(),
});
const CloseSchema = z.object({
  closing_amount:  z.number().nonnegative().optional(),
  closing_balance: z.number().nonnegative().optional(), // alias for backward compat
  closing_usd: z.number().nonnegative().optional(),     // dólares contados en cierre
  notes: z.string().optional().nullable(),
  /**
   * Cuándo se cerró DE VERDAD.
   *
   * Un cierre hecho sin conexión sube horas después. Sellarlo con la hora de la
   * subida deja el arqueo diciendo que la caja se cerró a las diez de la mañana
   * del día siguiente, y el cuadre contra las ventas del día deja de tener
   * sentido.
   */
  closed_at: z.string().optional().nullable(),
  /**
   * EL DETALLE DEL CIERRE, tal como se imprimió.
   *
   * Lo manda la pantalla del cierre: el mismo objeto que va a la impresora
   * (conteo por denominación, contado por método, abonos del turno,
   * movimientos del fondo, ventas a crédito). Sin esto, del arqueo quedaba
   * solo el monto: si el tiquete se perdía, ese turno no se podía volver a
   * sacar nunca. Con esto se reimprime idéntico desde Reportes.
   */
  cierre_detalle: z.any().optional().nullable(),
}).transform(d => ({
  ...d,
  closing_amount: d.closing_amount ?? d.closing_balance ?? 0,
}));

cashSessions.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = c.req.query('to');

    let query = db.from('cash_sessions').select('*').eq('tenant_id', tenantId)
      .order('opening_date', { ascending: false });
    if (from) query = query.gte('opening_date', from);
    if (to)   query = query.lte('opening_date', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

cashSessions.get('/active', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    /**
     * ¿CUÁL ES LA CAJA ABIERTA ACÁ?
     *
     * Con `?terminal=N` la respuesta es la de ESA MÁQUINA, sin importar quién
     * la abrió: así el relevo de turno sigue la misma gaveta en vez de abrir
     * otra encima, y la caja de la barra no se le aparece al de la entrada.
     *
     * Sin el parámetro, la de este usuario — como siempre.
     */
    const term = Number(c.req.query('terminal'));
    const porMaquina = Number.isFinite(term) && term >= 1;

    let q = db.from('cash_sessions').select('*')
      .eq('tenant_id', tenantId).eq('status', 'open');
    q = porMaquina ? q.eq('terminal', term) : q.eq('user_id', userId);

    const { data, error } = await q
      .order('opening_date', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);

    /* Una máquina recién configurada puede tener su caja abierta de ANTES, sin
       terminal anotada. Se adopta la del usuario para no obligarlo a cerrar a
       ciegas una caja que el POS ya no encuentra. */
    if (!data && porMaquina) {
      const { data: suya } = await db.from('cash_sessions').select('*')
        .eq('tenant_id', tenantId).eq('user_id', userId).eq('status', 'open')
        .is('terminal', null)
        .order('opening_date', { ascending: false }).limit(1).maybeSingle();
      if (suya) return ok(c, suya);
    }
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

cashSessions.post('/open', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId   = c.get('userId');
    const parsed   = OpenSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Solo una caja abierta POR USUARIO (no por tenant). Así cada cajero
    // maneja su propia sesión sin bloquear a los demás.
    //
    // Se piden hasta 2 filas a propósito: con `maybeSingle()`, un usuario que ya
    // tuviera DOS cajas abiertas hacía que la consulta devolviera error y `data`
    // null — el guard pasaba y se abría una TERCERA. Así se acumulaban sesiones
    // fantasma: la caja "se cerraba sola" (el POS pasaba a ver otra) y después no
    // dejaba abrir.
    /* Con máquina, el candado es POR MÁQUINA: lo que no puede haber es dos
       cajas abiertas sobre la misma gaveta. Que el mismo cajero tenga una en
       la caja 1 y otra en la caja 2 es lo normal en un local con dos cajas. */
    const term = parsed.data.terminal ?? null;
    let qAbiertas = db.from('cash_sessions')
      .select('*').eq('tenant_id', tenantId).eq('status', 'open');
    qAbiertas = term ? qAbiertas.eq('terminal', term) : qAbiertas.eq('user_id', userId);
    const { data: abiertas } = await qAbiertas
      .order('opening_date', { ascending: false }).limit(2);

    if ((abiertas ?? []).length > 0) {
      const actual: any = (abiertas ?? [])[0];
      if ((abiertas ?? []).length > 1) {
        console.warn(`[caja] ${term ? `la caja ${term}` : `el usuario ${userId}`} tiene ${(abiertas ?? []).length}+ cajas abiertas`);
      }
      // Se devuelve LA QUE YA ESTÁ para que el POS la adopte, en vez de dejar al
      // cajero trabado con "Ya tenés una caja abierta" sin poder hacer nada.
      return c.json({
        success: false,
        error: term
          ? `La ${actual.caja_nombre || `caja ${term}`} ya está abierta`
          : 'Ya tenés una caja abierta',
        existing_session: actual,
        duplicates: (abiertas ?? []).length,
      }, 409);
    }

    const { data, error } = await db.from('cash_sessions').insert({
      tenant_id:      tenantId,
      user_id:        userId,
      opening_amount: parsed.data.opening_amount,
      opening_usd:    parsed.data.opening_usd ?? 0,
      opening_date:   new Date().toISOString(),
      status:         'open',
      notes:          parsed.data.notes,
      terminal:       term,
      /* El nombre va COPIADO: si le cambian el nombre a la caja, el arqueo de
         hace tres meses tiene que seguir diciendo cómo se llamaba. */
      caja_nombre:    parsed.data.caja_nombre?.trim() || (term ? `Caja ${term}` : null),
    }).select().single();
    /* Sin la migración 139 estas dos columnas no existen todavía. La caja tiene
       que poder abrirse igual: se reintenta sin ellas y se avisa en el log. */
    if (error && /terminal|caja_nombre/.test(error.message)) {
      console.warn('[caja] sin la migración 139: la caja se abre sin máquina');
      const reintento = await db.from('cash_sessions').insert({
        tenant_id: tenantId, user_id: userId,
        opening_amount: parsed.data.opening_amount,
        opening_usd: parsed.data.opening_usd ?? 0,
        opening_date: new Date().toISOString(),
        status: 'open', notes: parsed.data.notes,
      }).select().single();
      if (reintento.error) throw new Error(reintento.error.message);
      return ok(c, reintento.data, 201);
    }
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id/invoices — ventas de una caja, resueltas del lado del SERVIDOR.
//
// El cierre pedía las facturas por `cash_session_id` desde el navegador, y si esa
// caja se abrió sin conexión (id local) o el enlace se rompió, no venía ninguna:
// el arqueo salía en 0 con la plata en el cajón. Acá, cuando la sesión no tiene
// facturas ligadas, se buscan las del PERÍODO de esa caja y del mismo cajero, y
// se avisa de dónde salieron para que la pantalla lo diga.

/**
 * EL COBRO DEL REPARTO, SACADO DE LAS LÍNEAS DE LA FACTURA.
 *
 * El domicilio se cobra como un artículo del catálogo («Entrega a domicilio»),
 * que es lo que lo hace funcionar con factura electrónica y lo que el cliente
 * ve en su tiquete. Por eso el monto no vive en una columna aparte: vive en la
 * línea, y acá se lee de ahí.
 *
 * Tener un total paralelo sería más cómodo de consultar y tarde o temprano
 * diría algo distinto que las líneas; cuando eso pasa, nadie sabe cuál de los
 * dos creer.
 *
 * Devuelve el monto cobrado de reparto por factura. Sin artículo configurado
 * en Ajustes → Delivery, devuelve vacío: no hay forma de saber qué línea es el
 * domicilio y adivinar sería peor.
 */
export async function repartoPorFactura(
  tenantId: string, invoiceIds: string[],
): Promise<Map<string, number>> {
  const salida = new Map<string, number>();
  if (invoiceIds.length === 0) return salida;
  try {
    const { data: cfg } = await db.from('settings').select('config')
      .eq('tenant_id', tenantId).eq('type', 'delivery').maybeSingle();
    const productoId = String((cfg as any)?.config?.reparto_producto_id ?? '').trim();
    if (!productoId) return salida;

    /* Por tandas: una caja de un día puede tener cientos de facturas y la
       consulta con todos los ids adentro se pasa del largo de una URL. */
    for (let i = 0; i < invoiceIds.length; i += 200) {
      const { data } = await db.from('invoice_items')
        .select('invoice_id, subtotal, quantity, unit_price')
        .eq('product_id', productoId).in('invoice_id', invoiceIds.slice(i, i + 200));
      for (const l of ((data ?? []) as any[])) {
        const monto = Number(l.subtotal ?? 0) || (Number(l.quantity ?? 0) * Number(l.unit_price ?? 0));
        salida.set(String(l.invoice_id), (salida.get(String(l.invoice_id)) ?? 0) + monto);
      }
    }
  } catch (e: any) {
    console.warn('[reparto] no se pudo leer el cobro de reparto:', e?.message);
  }
  return salida;
}

/** Le pega a cada factura cuánto cobró de reparto, para que el cierre lo separe. */
async function marcarReparto(tenantId: string, facturas: any[]) {
  const porFactura = await repartoPorFactura(tenantId, facturas.map(f => String(f.id)));
  for (const f of facturas) f.reparto = porFactura.get(String(f.id)) ?? 0;
}

cashSessions.get('/:id/invoices', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    const { data: sess } = await db.from('cash_sessions')
      .select('id, user_id, opening_date, closing_date, status')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!sess) return fail(c, 'Caja no encontrada', 404);

    const { data: ligadas, error } = await db.from('invoices').select('*')
      .eq('tenant_id', tenantId).eq('cash_session_id', id)
      .order('issued_at', { ascending: false }).limit(2000);
    if (error) throw new Error(error.message);

    if ((ligadas ?? []).length > 0) {
      await marcarReparto(tenantId, ligadas as any[]);
      return ok(c, { invoices: ligadas, source: 'session', session_id: id });
    }

    // Sin facturas ligadas: se busca por ventana de tiempo. Se excluye lo que ya
    // pertenece a OTRA caja, para no contar dos veces la misma venta.
    const desde = (sess as any).opening_date;
    const hasta = (sess as any).closing_date ?? new Date().toISOString();
    let q = db.from('invoices').select('*')
      .eq('tenant_id', tenantId)
      .gte('issued_at', desde).lte('issued_at', hasta)
      .order('issued_at', { ascending: false }).limit(2000);
    const { data: delPeriodo } = await q;

    const candidatas = (delPeriodo ?? []).filter((i: any) => {
      if (i.cash_session_id && i.cash_session_id !== id) return false;
      const owner = (sess as any).user_id;
      if (owner && i.cashier_id && i.cashier_id !== owner) return false;
      return true;
    });

    await marcarReparto(tenantId, candidatas);
    return ok(c, {
      invoices: candidatas,
      source: candidatas.length > 0 ? 'window' : 'empty',
      session_id: id,
      window: { from: desde, to: hasta },
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * EL CIERRE DE UNA CAJA, PARA REIMPRIMIRLO.
 *
 * GET /:id/cierre
 *
 * Dos caminos, y la respuesta dice cuál se usó:
 *
 * 1. `cierre_detalle` guardado (migración 152): se devuelve el MISMO objeto
 *    que se imprimió. La reimpresión sale idéntica al original, con el conteo
 *    por denominación y todo.
 * 2. Cajas cerradas antes de esa columna: se REARMA desde las ventas del
 *    turno. Lo que el sistema registró se recupera completo; lo que el cajero
 *    contó por método no se guardó nunca, así que de eso queda solo el total
 *    —y el papel lo dice, en vez de imprimir ceros que parecen un arqueo—.
 */
cashSessions.get('/:id/cierre', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();

    let sq: any = await db.from('cash_sessions')
      .select('id, user_id, opening_date, closing_date, status, opening_amount, closing_amount, closing_usd, opening_usd, notes, cierre_detalle')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (sq.error && /cierre_detalle/.test(sq.error.message ?? '')) {
      sq = await db.from('cash_sessions')
        .select('id, user_id, opening_date, closing_date, status, opening_amount, closing_amount, closing_usd, opening_usd, notes')
        .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    }
    const ses = sq.data as any;
    if (!ses) return fail(c, 'Caja no encontrada', 404);
    if (ses.status !== 'closed') {
      return fail(c, 'Esa caja todavía está abierta: el cierre no existe hasta que se cierre.', 409);
    }

    if (ses.cierre_detalle) {
      return ok(c, { detalle: ses.cierre_detalle, reconstruido: false });
    }

    // ── Rearmar desde las ventas del turno ──────────────────────────────────
    const COLS_FACT = 'total, payment_method, payments, status, is_delivery, exclude_from_close, currency, invoice_number, customer_name, issued_at, document_type';
    let fq: any = await db.from('invoices')
      .select(`${COLS_FACT}, void_reason`)
      .eq('tenant_id', tenantId).eq('cash_session_id', id).limit(2000);
    /* `void_reason` es de la migración 153: sin ella el cierre se rearma
       igual, solo que las anulaciones salen sin motivo. */
    if (fq.error && /void_reason/.test(fq.error.message ?? '')) {
      fq = await db.from('invoices').select(COLS_FACT)
        .eq('tenant_id', tenantId).eq('cash_session_id', id).limit(2000);
    }
    const todas = (fq.data ?? []) as any[];
    const vivas = todas.filter(i => i.status !== 'cancelled' && !i.exclude_from_close && !i.is_delivery);
    const anuladas = todas.filter(i => i.status === 'cancelled');

    const porMetodo: Record<string, number> = {
      cash: 0, card: 0, sinpe: 0, credit: 0, transfer: 0, other: 0,
    };
    for (const inv of vivas) {
      const pays = Array.isArray(inv.payments) && inv.payments.length ? inv.payments : null;
      const sumar = (m: string, a: number) => {
        const k = m === 'bank_transfer' || m === 'transferencia' ? 'transfer' : m;
        if (Object.prototype.hasOwnProperty.call(porMetodo, k)) porMetodo[k] += a;
        else porMetodo.other += a;
      };
      if (pays) for (const p of pays) sumar(String(p.method ?? ''), Number(p.amount || 0));
      else sumar(String(inv.payment_method ?? ''), Number(inv.total || 0));
    }

    const { data: movs } = await db.from('cash_movements')
      .select('type, amount, description')
      .eq('cash_session_id', id).neq('type', 'sale');
    const movimientos = ((movs ?? []) as any[])
      .filter(m => ['income', 'expense', 'cash_in', 'cash_out'].includes(String(m.type)))
      .map(m => ({
        type: (m.type === 'income' || m.type === 'cash_in') ? 'in' as const : 'out' as const,
        amount: Math.abs(Number(m.amount || 0)),
        reason: m.description ?? '',
      }));
    const entradas = movimientos.filter(m => m.type === 'in').reduce((t, m) => t + m.amount, 0);
    const salidas = movimientos.filter(m => m.type === 'out').reduce((t, m) => t + m.amount, 0);

    /* Los abonos del turno: de apartados y de cuentas por cobrar. Son plata
       que entró al cajón sin una venta detrás, así que sin ellos el esperado
       sale corto justo por lo abonado. */
    const abonos: Array<{ tipo: 'apartado' | 'credito'; numero: string | null; cliente: string | null; method: string; amount: number }> = [];
    try {
      const { data } = await db.from('reservation_payments')
        .select('amount, method, reservation:reservations(number, customer_name)')
        .eq('tenant_id', tenantId).eq('cash_session_id', id);
      for (const p of ((data ?? []) as any[])) {
        abonos.push({
          tipo: 'apartado', numero: p.reservation?.number ?? null,
          cliente: p.reservation?.customer_name ?? null,
          method: String(p.method ?? 'cash'), amount: Number(p.amount || 0),
        });
      }
    } catch { /* sin apartados */ }
    try {
      let r: any = await db.from('accounts_receivable_payments')
        .select('amount, method, voided_at, receivable:accounts_receivable(customer_name, invoice_number)')
        .eq('tenant_id', tenantId).eq('cash_session_id', id);
      if (r.error && /voided_at/.test(r.error.message ?? '')) {
        r = await db.from('accounts_receivable_payments')
          .select('amount, method, receivable:accounts_receivable(customer_name, invoice_number)')
          .eq('tenant_id', tenantId).eq('cash_session_id', id);
      }
      for (const p of ((r.data ?? []) as any[])) {
        if (p.voided_at) continue;   // un abono anulado no es plata del turno
        abonos.push({
          tipo: 'credito', numero: p.receivable?.invoice_number ?? null,
          cliente: p.receivable?.customer_name ?? null,
          method: String(p.method ?? 'cash'), amount: Number(p.amount || 0),
        });
      }
    } catch { /* sin cuentas por cobrar */ }

    for (const a of abonos) {
      const k = a.method === 'bank_transfer' ? 'transfer' : a.method;
      if (Object.prototype.hasOwnProperty.call(porMetodo, k)) porMetodo[k] += a.amount;
      else porMetodo.other += a.amount;
    }
    const porMedio: Record<string, { method: string; amount: number; count: number }> = {};
    for (const a of abonos) {
      porMedio[a.method] ??= { method: a.method, amount: 0, count: 0 };
      porMedio[a.method].amount += a.amount;
      porMedio[a.method].count += 1;
    }

    let cajero = 'Sin vendedor';
    if (ses.user_id) {
      const { data: u } = await db.from('users')
        .select('ticket_alias, full_name, email').eq('id', ses.user_id).maybeSingle();
      cajero = (u as any)?.ticket_alias || (u as any)?.full_name
        || String((u as any)?.email ?? '').split('@')[0] || 'Vendedor';
    }

    /**
     * EL DESGLOSE QUE SÍ ESTABA GUARDADO.
     *
     * El cierre viene escribiendo en `notes` una línea «Desglose: {…}» con lo
     * que el cajero contó por método, el esperado y la diferencia, desde mucho
     * antes de la columna `cierre_detalle`. Estaba ahí todo el tiempo: el
     * rearmado lo ignoraba y ponía ceros, así que el reimpreso de una caja
     * vieja salía sin arqueo por método aunque el dato existiera.
     *
     * Lo que NO está es el conteo por denominación (cuántos billetes de cada
     * uno): eso vive solo en `cierre_detalle`, y de un cierre viejo no se puede
     * recuperar. Esa sigue siendo la única parte que el papel declara perdida.
     */
    const desglose = (() => {
      const txt = String(ses.notes ?? '');
      const i = txt.indexOf('Desglose:');
      if (i < 0) return null;
      const j = txt.indexOf('{', i);
      if (j < 0) return null;
      try { return JSON.parse(txt.slice(j)); } catch { return null; }
    })();
    /** La nota que de verdad escribió el cajero, sin el JSON del desglose. */
    const notaHumana = (() => {
      const txt = String(ses.notes ?? '');
      const i = txt.indexOf('Desglose:');
      const limpio = (i < 0 ? txt : txt.slice(0, i)).trim();
      return limpio.length > 0 ? limpio : null;
    })();

    /**
     * EL ESPERADO, con el mismo criterio del cierre.
     *
     * Decía `fondo + efectivo + entradas − salidas`, pero lo compara contra
     * `closing_amount`, que es TODO lo contado —efectivo, tarjeta y SINPE
     * juntos—. Un turno con ₡125.800 de SINPE reimprimía un SOBRANTE de
     * ₡17.800 donde el original decía un FALTANTE de ₡116.000: el reimpreso
     * contradecía al papel que estaba reemplazando, que es la peor forma de
     * fallar que tiene un arqueo.
     *
     * Si el desglose guardado trae su esperado, manda ese: una reimpresión es
     * una COPIA del arqueo que se hizo, no un recálculo de hoy.
     */
    const esperadoCalc = Number(ses.opening_amount || 0)
      + porMetodo.cash + porMetodo.card + porMetodo.sinpe + entradas - salidas;
    const esperado = Number.isFinite(Number(desglose?.expectedTotal))
      ? Number(desglose.expectedTotal) : esperadoCalc;
    const contado = Number(ses.closing_amount ?? 0);
    const contadoPorMetodo = {
      cash: Number(desglose?.counted?.cash ?? 0),
      card: Number(desglose?.counted?.card ?? 0),
      sinpe: Number(desglose?.counted?.sinpe ?? 0),
    };
    /** ¿Se pudo recuperar lo contado por método, o va en ceros? */
    const conteoRecuperado = !!desglose?.counted;

    return ok(c, {
      reconstruido: true,
      detalle: {
        session_id: id,
        opened_at: ses.opening_date,
        closed_at: ses.closing_date,
        cashier_name: cajero,
        opening_amount: Number(ses.opening_amount || 0),
        system_cash: porMetodo.cash, system_card: porMetodo.card, system_sinpe: porMetodo.sinpe,
        system_credit: porMetodo.credit, system_transfer: porMetodo.transfer, system_other: porMetodo.other,
        /* Lo contado por método, recuperado del desglose guardado. Si esa
           caja no lo tiene, van en 0 y el papel lo dice: inventar el reparto
           sería escribir un arqueo que nadie hizo. */
        cash_total: contadoPorMetodo.cash,
        card_total: contadoPorMetodo.card,
        sinpe_total: contadoPorMetodo.sinpe,
        conteo_recuperado: conteoRecuperado,
        closing_amount: contado,
        expected_amount: esperado,
        difference: Number.isFinite(Number(desglose?.difference))
          ? Number(desglose.difference) : contado - esperado,
        non_countable_sales: porMetodo.credit + porMetodo.transfer + porMetodo.other,
        invoices_count: vivas.length,
        invoices_total: vivas.reduce((t, i) => t + Number(i.total || 0), 0),
        voids_count: anuladas.length,
        voids_total: anuladas.reduce((t, i) => t + Number(i.total || 0), 0),
        voids: anuladas.map(i => ({
          numero: i.invoice_number ?? null,
          cliente: i.customer_name ?? null,
          amount: Number(i.total || 0),
          motivo: i.void_reason ?? null,
        })),
        /* Venta por venta, en orden. Es con lo que se cuadra un arqueo que no
           cuadra, y el rearmado no lo traía: el reimpreso salía con los totales
           y sin nada que revisar. */
        sales: vivas
          .map(i => ({
            number: String(i.invoice_number ?? ''),
            time: String(i.issued_at ?? ''),
            method: String(i.payment_method ?? ''),
            total: Number(i.total ?? 0),
            kind: String(i.document_type ?? ''),
            cliente: String(i.customer_name ?? ''),
          }))
          .sort((x, y) => x.time.localeCompare(y.time)),
        reservations_total: abonos.reduce((t, a) => t + a.amount, 0),
        reservations_count: abonos.length,
        reservations_by_method: Object.values(porMedio).sort((x, y) => y.amount - x.amount),
        reservations: abonos,
        cash_movements: movimientos,
        opening_usd: Number(ses.opening_usd ?? 0),
        closing_usd: Number(ses.closing_usd ?? 0),
        // La nota del cajero, sin el JSON del desglose: el papel imprime esto
        // tal cual, y un volcado de JSON en el tiquete no lo lee nadie.
        notes: notaHumana,
      },
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PATCH /:id/opening — corrige el FONDO de una caja que ya está abierta.
//
// Hace falta porque la caja puede haberse abierto sola en ₡0 (negocios con "no
// abrir caja") o porque el cajero se equivocó al contar el fondo. Sin esto, el
// arqueo del día entero arrastra un fondo que no es, y el cierre marca faltante
// o sobrante por una diferencia que nunca existió.
cashSessions.patch('/:id/opening', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({} as any));
    const monto = Number(body?.opening_amount);
    if (!Number.isFinite(monto) || monto < 0) return fail(c, 'Monto de apertura inválido', 422);

    const { data: sess } = await db.from('cash_sessions')
      .select('id, status, opening_amount, notes').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!sess) return fail(c, 'Caja no encontrada', 404);
    if ((sess as any).status !== 'open') return fail(c, 'La caja ya está cerrada', 409);

    const anterior = Number((sess as any).opening_amount ?? 0);
    // Queda registro del cambio: un fondo que se corrige sin rastro es la forma
    // más fácil de tapar un faltante.
    const nota = [
      (sess as any).notes,
      `Fondo corregido: ₡${anterior.toLocaleString('es-CR')} → ₡${monto.toLocaleString('es-CR')} (${new Date().toISOString()})`,
    ].filter(Boolean).join(' | ');

    const { data, error } = await db.from('cash_sessions').update({
      opening_amount: monto,
      opening_usd: Number(body?.opening_usd ?? (sess as any).opening_usd ?? 0),
      notes: nota,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

cashSessions.post('/:id/close', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id }   = c.req.param();
    const parsed   = CloseSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Cajas fantasma: si el usuario tenía más de una abierta, cerrar solo la
    // actual dejaba la vieja viva — y al rato el POS la mostraba como si la caja
    // se hubiera reabierto sola. Se cierran las demás con nota, sin montos.
    try {
      const { data: sess } = await db.from('cash_sessions')
        .select('user_id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
      const owner = (sess as any)?.user_id;
      if (owner) {
        const { data: otras } = await db.from('cash_sessions')
          .select('id').eq('tenant_id', tenantId).eq('user_id', owner)
          .eq('status', 'open').neq('id', id);
        for (const o of (otras ?? []) as any[]) {
          await db.from('cash_sessions').update({
            status: 'closed',
            closing_date: new Date().toISOString(),
            notes: 'Cerrada automáticamente: quedó abierta por duplicado',
            updated_at: new Date().toISOString(),
          }).eq('id', o.id).eq('tenant_id', tenantId);
          console.warn(`[caja] se cerró la sesión duplicada ${o.id} del usuario ${owner}`);
        }
      }
    } catch (e: any) { console.warn('[caja] limpieza de duplicadas:', e?.message); }

    // Ya cerrada: NO se vuelve a cerrar.
    //
    // Un cierre encolado sin conexión puede subir dos veces (reintento tras una
    // respuesta perdida). Repetir el update pisaba el monto y la hora del cierre
    // bueno con los de la subida, y el arqueo original se perdía sin dejar
    // rastro. Se devuelve la sesión tal como quedó.
    {
      const { data: yaCerrada } = await db.from('cash_sessions')
        .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
      if ((yaCerrada as any)?.status === 'closed') {
        return ok(c, { ...(yaCerrada as any), already_closed: true });
      }
    }

    const cambios: Record<string, any> = {
      closing_amount: parsed.data.closing_amount,
      closing_usd:    parsed.data.closing_usd ?? null,
      closing_date:   parsed.data.closed_at ?? new Date().toISOString(),
      status:         'closed',
      notes:          parsed.data.notes,
      updated_at:     new Date().toISOString(),
    };
    if (parsed.data.cierre_detalle) cambios.cierre_detalle = parsed.data.cierre_detalle;

    let res = await db.from('cash_sessions').update(cambios)
      .eq('id', id).eq('tenant_id', tenantId).select().single();
    /* `cierre_detalle` es de la migración 152: si no corrió, la caja se cierra
       igual (sin poder reimprimir el detalle después). Perder el detalle es
       molesto; no poder CERRAR la caja deja al negocio sin poder trabajar. */
    if (res.error && /cierre_detalle/.test(res.error.message ?? '')) {
      const { cierre_detalle: _d, ...resto } = cambios;
      res = await db.from('cash_sessions').update(resto)
        .eq('id', id).eq('tenant_id', tenantId).select().single();
    }
    if (res.error) throw new Error(res.error.message);
    return ok(c, res.data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /daily-summary?date=YYYY-MM-DD — CONSOLIDADO DEL DÍA.
//
// Junta TODOS los cierres del día natural (00:00 a 00:00, hora de Costa Rica) en
// un solo resumen. Un negocio puede abrir y cerrar caja varias veces —cambio de
// turno, dos cajeros, una caja que se cerró por error— y hasta ahora la única
// forma de saber cuánto vendió el día era sumar los tiquetes a mano.
cashSessions.get('/daily-summary', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    // Día en hora de CR: sin esto, cerrar a las 7pm caía en el día siguiente UTC.
    const date = c.req.query('date')
      || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
    const from = `${date}T00:00:00`;
    const to = `${date}T23:59:59.999`;

    const { data: sessions, error } = await db.from('cash_sessions')
      .select('id, opening_amount, closing_amount, opening_date, closing_date, status, user_id, notes')
      .eq('tenant_id', tenantId)
      .gte('opening_date', from).lte('opening_date', to)
      .order('opening_date');
    if (error) throw new Error(error.message);
    const list = (sessions ?? []) as any[];
    if (list.length === 0) return ok(c, { date, sessions: [], totals: null });

    // Nombre del cajero de cada sesión.
    const userIds = [...new Set(list.map(s2 => s2.user_id).filter(Boolean))];
    const nameByUser = new Map<string, string>();
    if (userIds.length) {
      const { data: users } = await db.from('users').select('id, full_name, email').in('id', userIds as string[]);
      for (const u of (users ?? []) as any[]) nameByUser.set(u.id, u.full_name || u.email || '');
    }

    // Ventas por sesión. Se excluye lo que no entra al arqueo, igual que el cierre
    // individual: anuladas, delivery y clientes excluidos.
    const ids = list.map(s2 => s2.id);
    const { data: invs } = await db.from('invoices')
      .select('cash_session_id, total, payment_method, status, is_delivery, exclude_from_close')
      .in('cash_session_id', ids);

    const bySession = new Map<string, any>();
    for (const id of ids) {
      bySession.set(id, { cash: 0, card: 0, sinpe: 0, credit: 0, transfer: 0, other: 0, count: 0, total: 0 });
    }
    let anuladas = 0, anuladasTotal = 0, delivery = 0, deliveryTotal = 0;
    for (const i of (invs ?? []) as any[]) {
      const acc = bySession.get(i.cash_session_id);
      if (!acc) continue;
      const amount = Number(i.total ?? 0);
      if (i.status === 'cancelled') { anuladas++; anuladasTotal += amount; continue; }
      if (i.is_delivery) { delivery++; deliveryTotal += amount; continue; }
      if (i.exclude_from_close) continue;
      const m = String(i.payment_method ?? '');
      if (m === 'cash') acc.cash += amount;
      else if (m === 'card') acc.card += amount;
      else if (m === 'sinpe') acc.sinpe += amount;
      else if (m === 'credit') acc.credit += amount;
      else if (m === 'transfer' || m === 'bank_transfer') acc.transfer += amount;
      else acc.other += amount;
      acc.count++; acc.total += amount;
    }

    const sessionsOut = list.map(s2 => ({
      id: s2.id,
      cashier: nameByUser.get(s2.user_id) ?? '',
      opened_at: s2.opening_date, closed_at: s2.closing_date,
      status: s2.status,
      opening_amount: Number(s2.opening_amount ?? 0),
      closing_amount: Number(s2.closing_amount ?? 0),
      ...bySession.get(s2.id),
    }));

    const sum = (k: string) => sessionsOut.reduce((acc, s2: any) => acc + Number(s2[k] ?? 0), 0);
    return ok(c, {
      date,
      sessions: sessionsOut,
      totals: {
        sesiones: sessionsOut.length,
        abiertas: sessionsOut.filter(s2 => s2.status !== 'closed').length,
        facturas: sum('count'),
        cash: sum('cash'), card: sum('card'), sinpe: sum('sinpe'),
        credit: sum('credit'), transfer: sum('transfer'), other: sum('other'),
        ventas: sum('total'),
        // Lo que se puede contar en caja (el crédito y la transferencia no).
        arqueable: sum('cash') + sum('card') + sum('sinpe'),
        fondos: sum('opening_amount'),
        contado: sum('closing_amount'),
        anuladas, anuladas_total: anuladasTotal,
        delivery, delivery_total: deliveryTotal,
      },
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /movements-report?from=&to= — Entradas y salidas del FONDO de caja del tenant
// (movimientos manuales + apertura/cierre; EXCLUYE las ventas). Para el reporte
// descargable. Se filtra por tenant vía las sesiones (cash_movements no tiene tenant).
cashSessions.get('/movements-report', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = c.req.query('to');

    // Sesiones del tenant → sus ids + datos (para atribuir cajero y fecha de apertura).
    const { data: sessions, error: sErr } = await db.from('cash_sessions')
      .select('id, opening_date, user_id, status').eq('tenant_id', tenantId);
    if (sErr) throw new Error(sErr.message);
    const sessList = (sessions ?? []) as any[];
    const sessionIds = sessList.map(s => s.id);
    if (sessionIds.length === 0) return ok(c, { movements: [] });
    const sessById = new Map(sessList.map(s => [s.id, s]));

    // Nombre del cajero por sesión (users.full_name).
    const userIds = [...new Set(sessList.map(s => s.user_id).filter(Boolean))];
    const nameByUser = new Map<string, string>();
    if (userIds.length) {
      const { data: users } = await db.from('users').select('id, full_name').in('id', userIds as string[]);
      for (const u of (users ?? []) as any[]) nameByUser.set(u.id, u.full_name ?? '');
    }

    let q = db.from('cash_movements').select('*')
      .in('cash_session_id', sessionIds)
      .neq('type', 'sale')                         // el fondo de caja NO incluye ventas
      .order('created_at', { ascending: false });
    if (from) q = q.gte('created_at', from);
    if (to)   q = q.lte('created_at', endOfDay(to));
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const movements = (data ?? []).map((m: any) => {
      const s = sessById.get(m.cash_session_id);
      return {
        ...m,
        cashier_name: s ? (nameByUser.get(s.user_id) ?? '') : '',
        session_opened_at: s?.opening_date ?? null,
      };
    });
    return ok(c, { movements });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id/movements — list cash movements for a session (usado por el cierre)
cashSessions.get('/:id/movements', async (c) => {
  try {
    const { id } = c.req.param();
    const { data, error } = await db.from('cash_movements')
      .select('*')
      .eq('cash_session_id', id)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/movements — register cash movement
cashSessions.post('/:id/movements', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const { data, error } = await db.from('cash_movements').insert({
      cash_session_id: id,
      type:            body.type,
      amount:          body.amount,
      description:     body.description ?? '',
      reference_id:    body.reference_id ?? null,
    }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * PUT /movements/:id — completar los datos de una entrada o salida.
 *
 * En la caja la gente registra el movimiento a la carrera y el motivo, el
 * proveedor o el número de factura quedan en blanco; después, al cuadrar el mes,
 * no hay forma de saber qué fue. Esto deja arreglarlo desde el reporte.
 *
 * El MONTO y el TIPO no se tocan: cambiarlos descuadraría un arqueo ya cerrado.
 * Acá solo se completa la descripción y la referencia.
 */
cashSessions.put('/movements/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({} as any));

    // El movimiento no guarda tenant_id: se valida a través de su sesión.
    const { data: mov } = await db.from('cash_movements')
      .select('id, cash_session_id, type').eq('id', id).maybeSingle();
    if (!mov) return fail(c, 'Movimiento no encontrado', 404);
    const { data: sess } = await db.from('cash_sessions')
      .select('id, tenant_id').eq('id', (mov as any).cash_session_id).maybeSingle();
    if (!sess || (sess as any).tenant_id !== tenantId) {
      return fail(c, 'Movimiento no encontrado', 404);
    }

    const patch: Record<string, any> = {};
    if (body.description !== undefined) patch.description = String(body.description ?? '');
    if (body.reference_id !== undefined) patch.reference_id = body.reference_id || null;
    if (Object.keys(patch).length === 0) return fail(c, 'Nada que actualizar', 422);

    const { data, error } = await db.from('cash_movements')
      .update(patch).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default cashSessions;
