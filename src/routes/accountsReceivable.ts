import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { getUserZone } from '../utils/userZone.js';
import { endOfDay } from '../utils/dateRange.js';
import { nextInvoiceNumber, consecutivoFloor } from './invoices.js';
import { emitInvoiceCore } from './hacienda.js';

const accountsReceivable = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/** Mapa customer_id → zona, para filtrar/etiquetar CxC por zona. */
/**
 * Zona de cada cliente.
 *
 * Se consultan SOLO los clientes que aparecen en las cuentas (por lotes), no el
 * catálogo entero: con miles de clientes, recorrerlo completo en cada carga se
 * comía el tiempo de la función y la pantalla terminaba vacía —sin cuentas y sin
 * error— que es exactamente como se ve "no aparece ninguno".
 */
async function customerZoneMap(tenantId: string, ids?: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();

  if (ids && ids.length > 0) {
    const CHUNK = 300;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await db.from('customers')
        .select('id, zone').eq('tenant_id', tenantId).in('id', ids.slice(i, i + CHUNK));
      if (error) break;
      for (const c of (data ?? []) as any[]) map.set(c.id, c.zone ?? null);
    }
    return map;
  }

  // Sin lista de ids: catálogo completo, paginado (Supabase corta en 1000).
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('customers')
      .select('id, zone').eq('tenant_id', tenantId)
      // Orden estable: paginar sin orden hace que algunas filas se repitan y
      // otras no salgan nunca — acá, clientes que quedaban sin zona.
      .order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) break;
    const chunk = data ?? [];
    for (const c of chunk as any[]) map.set(c.id, c.zone ?? null);
    if (chunk.length < PAGE) break;
  }
  return map;
}

const ARSchema = z.object({
  customer_id:    z.string().uuid().optional().nullable(),
  customer_name:  z.string().optional().nullable(),
  invoice_id:     z.string().uuid().optional().nullable(),
  invoice_number: z.string().optional().nullable(),
  total_amount:   z.number().positive(),
  paid_amount:    z.number().nonnegative().optional().default(0),
  due_date:       z.string().optional().nullable(),
  source:         z.enum(['pos', 'manual', 'distribution']).optional().default('manual'),
  notes:          z.string().optional().nullable(),
});

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Marca como vencida (overdue) si pasó la fecha y sigue debiéndose.
 *
 * Una cuenta ANULADA no se toca. Antes la condición era «distinta de pagada», y
 * como una cuenta anulada tampoco está pagada, al pasar su fecha volvía a
 * aparecer como vencida: la anulación se borraba en la lectura. El cliente
 * quedaba debiendo una factura que ya se había anulado, y la única forma de
 * notarlo era que el saldo no cuadrara.
 */
const CERRADAS = ['paid', 'cancelled'];

function withDerivedStatus(row: any) {
  if (!CERRADAS.includes(String(row.status)) && row.due_date && row.due_date < today()) {
    return { ...row, status: 'overdue' };
  }
  return row;
}

/** ¿Esta cuenta sigue debiéndose? Anulada y pagada NO cuentan. */
const debeAlgo = (r: any) =>
  !CERRADAS.includes(String(r.status))
  && (Number(r.total_amount ?? 0) - Number(r.paid_amount ?? 0)) > 0;

// Crea una cuenta por cobrar (reutilizable desde POS / distribución).
/**
 * CREA LA CUENTA POR COBRAR de una venta a crédito.
 *
 * ── Esto TIENE que reventar cuando falla ─────────────────────────────────
 * Antes devolvía el `{ data, error }` de Supabase tal cual, y supabase-js NO
 * rechaza la promesa: un insert fallido volvía como un objeto con `error`
 * adentro. Los cuatro lugares que llaman esto hacen `await createReceivable()`
 * dentro de un `try/catch`, así que el catch no se enteraba de nada: la venta a
 * crédito quedaba registrada y su cuenta por cobrar NO se creaba, sin error en
 * pantalla y sin una línea en el log.
 *
 * Eso es lo que se veía como «los créditos no están cargando»: la mercadería
 * salió, el cliente debe, y la deuda no existe en ninguna parte.
 *
 * Ahora lanza con el mensaje de la base, para que el que llama decida qué
 * hacer —y, sobre todo, para que se sepa—.
 */
export async function createReceivable(tenantId: string, r: {
  customer_id?: string | null; customer_name?: string | null;
  invoice_id?: string | null; invoice_number?: string | null;
  total_amount: number; due_date?: string | null;
  source: 'pos' | 'manual' | 'distribution'; notes?: string | null;
}) {
  const res = await db.from('accounts_receivable').insert({
    tenant_id: tenantId,
    customer_id: r.customer_id ?? null,
    customer_name: r.customer_name ?? null,
    invoice_id: r.invoice_id ?? null,
    invoice_number: r.invoice_number ?? null,
    total_amount: r.total_amount,
    paid_amount: 0,
    due_date: r.due_date ?? null,
    status: 'pending',
    source: r.source,
    notes: r.notes ?? null,
  }).select().single();

  if (res.error) {
    throw new Error(
      `No se pudo crear la cuenta por cobrar de ${r.invoice_number ?? 'la venta'}: ${res.error.message}`);
  }
  return res;
}

/**
 * LAS VENTAS A CRÉDITO QUE SE QUEDARON SIN CUENTA POR COBRAR.
 *
 * Cuando el insert de la cuenta fallaba, la venta a crédito quedaba igual y la
 * deuda no existía en ninguna parte: nadie la ve, nadie la cobra, y el cliente
 * aparece al día. Esas ventas están en la base —son facturas con
 * `payment_method = 'credit'` sin fila en `accounts_receivable`— así que se
 * pueden encontrar y rehacer.
 *
 * GET  /huerfanas → las lista, sin cambiar nada.
 * POST /huerfanas/reparar → les crea la cuenta que les falta.
 *
 * El vencimiento se calcula desde la fecha de la VENTA (30 días), no desde hoy:
 * una factura de hace tres semanas no vence el mes que viene.
 */
const huerfanasDeCredito = async (
  tenantId: string, from?: string, to?: string,
  /**
   * SOLO ESTAS FACTURAS.
   *
   * Lo usa el cierre de caja: ahí hay que revisar los créditos de ESTE turno,
   * no los del día entero. Con el rango de fechas, el cajero que cierra a las
   * 6 p.m. repararía también los créditos del turno de la mañana —que son de
   * otro cajero y pueden estar a medio arreglar—.
   */
  ids?: string[],
) => {
  if (ids && ids.length === 0) return [];
  let q = db.from('invoices')
    .select('id, invoice_number, customer_id, customer_name, total, issued_at, created_at, route_id')
    .eq('tenant_id', tenantId)
    .eq('payment_method', 'credit')
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(2000);
  if (ids && ids.length > 0) q = q.in('id', ids.slice(0, 500));
  if (from) q = q.gte('created_at', `${from}T00:00:00`);
  if (to)   q = q.lte('created_at', `${to}T23:59:59`);
  const { data: credito, error } = await q;
  if (error) throw new Error(error.message);

  const facturas = (credito ?? []) as any[];
  if (facturas.length === 0) return [];

  /* Las cuentas que YA existen, por tandas: con cientos de ids adentro la
     consulta se pasa del largo de una URL. */
  const conCuenta = new Set<string>();
  const facturaIds = facturas.map(f => String(f.id));
  for (let i = 0; i < facturaIds.length; i += 200) {
    const { data: ars } = await db.from('accounts_receivable')
      .select('invoice_id').eq('tenant_id', tenantId).in('invoice_id', facturaIds.slice(i, i + 200));
    for (const a of ((ars ?? []) as any[])) conCuenta.add(String(a.invoice_id));
  }
  return facturas.filter(f => !conCuenta.has(String(f.id)));
};

accountsReceivable.get('/huerfanas', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const faltan = await huerfanasDeCredito(tenantId, c.req.query('from'), c.req.query('to'));
    return ok(c, {
      cuantas: faltan.length,
      total: Math.round(faltan.reduce((t, f) => t + (Number(f.total) || 0), 0) * 100) / 100,
      /** De ruta o del punto de venta: dice dónde mirar el origen del problema. */
      de_ruta: faltan.filter(f => f.route_id).length,
      facturas: faltan.map(f => ({
        id: f.id, invoice_number: f.invoice_number,
        customer_name: f.customer_name ?? null,
        total: Number(f.total) || 0,
        fecha: f.issued_at ?? f.created_at,
        de_ruta: !!f.route_id,
      })),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

accountsReceivable.post('/huerfanas/reparar', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({} as any));
    const ids = Array.isArray(body?.invoice_ids)
      ? body.invoice_ids.map((x: any) => String(x)).filter(Boolean) : undefined;
    const faltan = await huerfanasDeCredito(tenantId, body?.from, body?.to, ids);

    const creadas: string[] = [];
    const fallaron: Array<{ invoice_number: string; motivo: string }> = [];
    for (const f of faltan) {
      /* 30 días desde la VENTA. Con `new Date()` una factura de hace tres
         semanas vencería el mes entrante y saldría del listado de vencidas,
         que es justo el que alguien mira para ir a cobrar. */
      const base = new Date(f.issued_at ?? f.created_at ?? Date.now());
      const vence = new Date(base.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
      try {
        await createReceivable(tenantId, {
          customer_id: f.customer_id ?? null,
          customer_name: f.customer_name ?? null,
          invoice_id: f.id, invoice_number: f.invoice_number,
          total_amount: Number(f.total ?? 0),
          due_date: vence,
          source: f.route_id ? 'distribution' : 'pos',
          notes: 'Cuenta rehecha: la venta a crédito había quedado sin cuenta por cobrar',
        });
        creadas.push(String(f.invoice_number ?? f.id));
      } catch (e: any) {
        /* El motivo REAL de la base, factura por factura: es lo que dice por
           qué fallaban —una columna que falta, un cliente borrado— en vez de
           dejarlo en «no se pudo». */
        fallaron.push({ invoice_number: String(f.invoice_number ?? f.id), motivo: e?.message ?? 'error' });
      }
    }

    return ok(c, {
      revisadas: faltan.length,
      creadas: creadas.length,
      lista_creadas: creadas,
      fallaron,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * ¿ESTOS CRÉDITOS QUEDARON COMO CUENTA POR COBRAR?
 *
 * GET /credito-estado?invoice_ids=a,b,c
 *
 * Lo pregunta el CIERRE DE CAJA. Hasta ahora el cierre listaba las ventas a
 * crédito del turno y ahí terminaba: decía a quién se le dio crédito, pero no
 * si la deuda existe en alguna parte. Cuando el insert de la cuenta falla —y
 * falla en silencio: la venta se cobra igual— el crédito queda sin cuenta, el
 * cliente aparece al día, y nadie lo descubre hasta que pasan meses.
 *
 * El cierre es el único momento del día en que alguien está mirando
 * exactamente esas ventas, así que es donde conviene avisar.
 */
accountsReceivable.get('/credito-estado', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const ids = String(c.req.query('invoice_ids') ?? '')
      .split(',').map(x => x.trim()).filter(Boolean).slice(0, 500);
    if (ids.length === 0) return ok(c, { cuentas: {}, sin_cuenta: [] });

    const cuentas: Record<string, any> = {};
    // Por tandas: con cientos de ids la consulta se pasa del largo de una URL.
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from('accounts_receivable')
        .select('id, invoice_id, total_amount, paid_amount, status, due_date')
        .eq('tenant_id', tenantId).in('invoice_id', ids.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const a of ((data ?? []) as any[])) {
        const total = Number(a.total_amount ?? 0), pagado = Number(a.paid_amount ?? 0);
        cuentas[String(a.invoice_id)] = {
          id: a.id, total, pagado,
          saldo: Math.round((total - pagado) * 100) / 100,
          status: a.status ?? 'pending',
          due_date: a.due_date ?? null,
        };
      }
    }
    return ok(c, { cuentas, sin_cuenta: ids.filter(id => !cuentas[id]) });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /  ?status=&customer_id=
// GET /scope — qué está viendo este usuario y por qué.
//
// Los usuarios con ZONA asignada solo ven las cuentas de su zona. Eso es
// deliberado (un vendedor de ruta no cobra la cartera de otro), pero desde la
// pantalla se veía igual que "faltan clientes": no había forma de saber que
// había un filtro puesto por el rol.
accountsReceivable.get('/scope', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const zone = await getUserZone(c.get('userId'));
    // Cuántos clientes hay en total y cuántos entran en la zona del usuario.
    let total = 0, enZona = 0;
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data } = await db.from('customers')
        .select('id, zone').eq('tenant_id', tenantId)
      // Orden estable: paginar sin orden hace que algunas filas se repitan y
      // otras no salgan nunca — acá, clientes que quedaban sin zona.
      .order('id', { ascending: true }).range(from, from + PAGE - 1);
      const chunk = data ?? [];
      total += chunk.length;
      if (zone) enZona += (chunk as any[]).filter(x => x.zone === zone).length;
      if (chunk.length < PAGE) break;
    }
    return ok(c, { zone, customers_total: total, customers_visible: zone ? enZona : total });
  } catch (err: any) { return fail(c, err.message, 500); }
});

accountsReceivable.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status');
    const customerId = c.req.query('customer_id');
    // Paginado: Supabase devuelve máximo 1000 filas por consulta. Sin esto, un
    // negocio con muchas cuentas recibía solo las 1000 más recientes y las
    // viejas —con sus clientes— simplemente no aparecían en la pantalla ni en
    // los selectores de abono e impresión.
    const PAGE = 1000;
    const all: any[] = [];
    for (let from = 0; ; from += PAGE) {
      let query = db.from('accounts_receivable').select('*')
        .eq('tenant_id', tenantId).order('created_at', { ascending: false })
        .range(from, from + PAGE - 1);
      if (customerId) query = query.eq('customer_id', customerId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const chunk = data ?? [];
      all.push(...chunk);
      if (chunk.length < PAGE) break;   // última página
    }
    let rows = all.map(withDerivedStatus);
    // Datos de la factura de origen: número y, sobre todo, si el comprobante
    // llegó a HACIENDA.
    //
    // «Tiene factura» y «tiene comprobante electrónico» no son lo mismo: una
    // venta documentada con tiquete CORRIENTE crea su factura interna pero nunca
    // se declaró. Confundirlas hacía que al cobrar esas cuentas el sistema
    // creyera que el ingreso ya estaba declarado y no emitiera nada.
    const invIds = [...new Set(rows.filter((r: any) => r.invoice_id).map((r: any) => r.invoice_id))];
    if (invIds.length > 0) {
      const byId = new Map<string, any>();
      // Paginado: un negocio con muchas cuentas supera las 1000 facturas.
      const PAGE_I = 500;
      for (let i = 0; i < invIds.length; i += PAGE_I) {
        const { data: invs } = await db.from('invoices')
          .select('id, invoice_number, fe_clave, document_type')
          .in('id', invIds.slice(i, i + PAGE_I));
        for (const inv of (invs ?? []) as any[]) byId.set(inv.id, inv);
      }
      rows = rows.map((r: any) => {
        const inv = r.invoice_id ? byId.get(r.invoice_id) : null;
        if (!inv) return { ...r, invoice_electronic: false };
        return {
          ...r,
          invoice_number: r.invoice_number ?? inv.invoice_number,
          // Electrónico = tiene clave de Hacienda. El tipo de documento por sí
          // solo no basta: una venta marcada como electrónica que fue rechazada
          // tampoco quedó declarada.
          invoice_electronic: !!inv.fe_clave,
          invoice_document_type: inv.document_type ?? null,
        };
      });
    } else {
      rows = rows.map((r: any) => ({ ...r, invoice_electronic: false }));
    }
    if (status) rows = rows.filter((r: any) => r.status === status);

    // Zona: restricción por usuario (repartidor) o filtro por query. Etiqueta cada CxC.
    const zmap = await customerZoneMap(tenantId,
      [...new Set(rows.map((r: any) => r.customer_id).filter(Boolean))] as string[]);
    rows = rows.map((r: any) => ({ ...r, zone: r.customer_id ? (zmap.get(r.customer_id) ?? null) : null }));
    const filterZone = (await getUserZone(c.get('userId'))) ?? c.req.query('zone') ?? null;
    if (filterZone) rows = rows.filter((r: any) => r.zone === filterZone);

    return ok(c, rows);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /summary — totales y saldo por cliente
accountsReceivable.get('/summary', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data } = await db.from('accounts_receivable').select('*')
      .eq('tenant_id', tenantId);
    let rows = (data ?? []).map(withDerivedStatus);

    // Zona por cliente + restricción/filtro.
    const zmap = await customerZoneMap(tenantId,
      [...new Set(rows.map((r: any) => r.customer_id).filter(Boolean))] as string[]);
    rows = rows.map((r: any) => ({ ...r, zone: r.customer_id ? (zmap.get(r.customer_id) ?? null) : null }));
    const filterZone = (await getUserZone(c.get('userId'))) ?? c.req.query('zone') ?? null;
    if (filterZone) rows = rows.filter((r: any) => r.zone === filterZone);

    // Las anuladas no suman al saldo: la deuda dejó de existir con la factura.
    const outstanding = rows.filter(debeAlgo)
      .reduce((s: number, r: any) => s + (Number(r.total_amount) - Number(r.paid_amount)), 0);
    const overdue = rows.filter((r: any) => r.status === 'overdue');
    const overdueAmount = overdue.reduce((s: number, r: any) => s + (Number(r.total_amount) - Number(r.paid_amount)), 0);
    const byCustomer: Record<string, { customer_id: string | null; customer_name: string; zone: string | null; balance: number; count: number }> = {};
    for (const r of rows) {
      if (!debeAlgo(r)) continue;
      const bal = Number(r.total_amount) - Number(r.paid_amount);
      const key = r.customer_id ?? r.customer_name ?? 'sin';
      if (!byCustomer[key]) byCustomer[key] = { customer_id: r.customer_id ?? null, customer_name: r.customer_name ?? 'Sin cliente', zone: r.zone ?? null, balance: 0, count: 0 };
      byCustomer[key].balance += bal;
      byCustomer[key].count += 1;
    }
    return ok(c, {
      outstanding, overdue_count: overdue.length, overdue_amount: overdueAmount,
      pending_count: rows.filter(debeAlgo).length,
      by_customer: Object.values(byCustomer).sort((a, b) => b.balance - a.balance),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * GET /payments — ABONOS COBRADOS (el dinero que entró por cuentas por cobrar).
 *
 * El abono es plata que entra y no es una venta: la venta a crédito ya se
 * facturó el día que se despachó. Por eso no aparecía en ningún lado como
 * ingreso —ni en el cierre de caja ni en los reportes—, y el único rastro era
 * que el saldo del cliente bajaba.
 *
 * ?session=<id> — abonos de esa caja (lo que usa el cierre). Entran dos cosas:
 *   los LIGADOS a la caja, y los que no quedaron ligados pero los cobró EL
 *   MISMO USUARIO de esa caja dentro de su turno.
 *
 *   Lo segundo hace falta de verdad: medido en esta base, de los abonos que
 *   caen dentro de una caja en la última semana, el 100 % los tomó el mismo
 *   usuario que la abrió, y ninguno quedó ligado —porque el vínculo es nuevo y
 *   todo lo cobrado antes tiene la columna vacía—. Sin este rescate, el cajero
 *   cobra una cuenta, guarda la plata, y el cierre no la menciona.
 *
 *   Por horario a secas NO: eso metería al arqueo lo que se cobró en la oficina
 *   o por depósito y le haría sobrar plata al cajero. El usuario es lo que
 *   separa «lo cobré yo en esta caja» de «lo cobró otro en otro lado».
 * ?from=&to=    — por fecha, para los reportes.
 *
 * Los abonos ANULADOS nunca salen: esa plata se devolvió.
 */
accountsReceivable.get('/payments', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const sessionId = c.req.query('session');
    const desde = c.req.query('from');
    const hasta = c.req.query('to');

    const columnas = 'id, receivable_id, amount, method, note, created_at, user_id,'
      + ' receivable:accounts_receivable(customer_name, invoice_number, source)';

    const consulta = (conSesion: boolean, conAnulados: boolean) => {
      let q = db.from('accounts_receivable_payments')
        .select(conAnulados ? `${columnas}, voided_at` : columnas)
        .eq('tenant_id', tenantId).order('created_at');
      if (conSesion && sessionId) q = q.eq('cash_session_id', sessionId);
      if (desde) q = q.gte('created_at', desde);
      if (hasta) q = q.lte('created_at', endOfDay(hasta) ?? hasta);
      return q;
    };

    // `voided_at` es de la migración 63 y `cash_session_id` de la 144: si alguna
    // no corrió, se responde lo que sí se pueda leer en vez de dejar el cierre
    // sin abonos. Lo que no se puede es filtrar por una caja que no existe en la
    // tabla: eso devolvería TODOS los abonos del negocio como si fueran de este
    // turno, así que en ese caso se responde vacío.
    let res: any = await consulta(true, true);
    let sinColumnaSesion = false;
    if (res.error && /cash_session_id/.test(res.error.message ?? '')) {
      if (sessionId) return ok(c, []);
      sinColumnaSesion = true;
      res = await consulta(false, true);
    }
    if (res.error && /voided_at/.test(res.error.message ?? '')) {
      res = await consulta(!sinColumnaSesion, false);
    }
    if (res.error) throw new Error(res.error.message);

    let filas = ((res.data ?? []) as any[]).filter((p) => !p.voided_at);
    const ligados = new Set(filas.map((p) => String(p.id)));

    /**
     * RESCATE POR USUARIO Y HORARIO, para la caja.
     *
     * Los abonos cobrados antes de que existiera el vínculo —y los que se
     * tomaron sin conexión— tienen `cash_session_id` vacío. Se suman solo si
     * los cobró el MISMO usuario de la caja dentro de su turno: eso es su
     * propia plata en su propia gaveta. Un abono de otro usuario no entra, por
     * más que caiga en el mismo horario.
     */
    if (sessionId && !sinColumnaSesion) {
      const { data: ses } = await db.from('cash_sessions')
        .select('user_id, opening_date, closing_date')
        .eq('id', sessionId).eq('tenant_id', tenantId).maybeSingle();
      const abre = (ses as any)?.opening_date;
      const duenoCaja = (ses as any)?.user_id;
      if (abre && duenoCaja) {
        const cierra = (ses as any)?.closing_date ?? new Date().toISOString();
        let r: any = await db.from('accounts_receivable_payments')
          .select(`${columnas}, voided_at`)
          .eq('tenant_id', tenantId).is('cash_session_id', null)
          .eq('user_id', duenoCaja)
          .gte('created_at', abre).lte('created_at', cierra)
          .order('created_at');
        if (r.error && /voided_at/.test(r.error.message ?? '')) {
          r = await db.from('accounts_receivable_payments')
            .select(columnas)
            .eq('tenant_id', tenantId).is('cash_session_id', null)
            .eq('user_id', duenoCaja)
            .gte('created_at', abre).lte('created_at', cierra)
            .order('created_at');
        }
        if (!r.error) {
          const rescatados = ((r.data ?? []) as any[])
            .filter((p) => !p.voided_at && !ligados.has(String(p.id)))
            .map((p) => ({ ...p, __rescatado: true }));
          filas = [...filas, ...rescatados]
            .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        }
      }
    }

    return ok(c, filas.map((p) => ({
      id: p.id,
      receivable_id: p.receivable_id,
      cliente: p.receivable?.customer_name ?? null,
      factura: p.receivable?.invoice_number ?? null,
      origen: p.receivable?.source ?? null,
      amount: Number(p.amount ?? 0),
      method: p.method ?? 'cash',
      note: p.note ?? null,
      user_id: p.user_id ?? null,
      created_at: p.created_at,
      /* `false` = no quedó ligado a la caja; se sumó porque lo cobró el mismo
         usuario en su turno. La pantalla lo puede decir, que es distinto de
         esconderlo. */
      ligado: p.__rescatado ? false : true,
    })));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id — con historial de abonos
accountsReceivable.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data, error } = await db.from('accounts_receivable').select('*')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Cuenta por cobrar no encontrada', 404);
    // Si no guardó el nº de factura pero tiene invoice_id, lo traemos de la factura.
    let row: any = data;
    if (!row.invoice_number && row.invoice_id) {
      const { data: inv } = await db.from('invoices').select('invoice_number').eq('id', row.invoice_id).maybeSingle();
      if ((inv as any)?.invoice_number) row = { ...row, invoice_number: (inv as any).invoice_number };
    }
    const { data: payments } = await db.from('accounts_receivable_payments')
      .select('*').eq('receivable_id', id).order('created_at', { ascending: false });
    /* Cada abono dice si su caja ya está cerrada: la pantalla lo avisa ANTES
       de que alguien toque «Anular», no después. */
    const cajas = await estadoDeCajas(
      tenantId, ((payments ?? []) as any[]).map(p => String(p.cash_session_id ?? '')));
    const conCaja = ((payments ?? []) as any[]).map(p => {
      const c0 = cajas.get(String(p.cash_session_id ?? ''));
      return { ...p, caja_cerrada: c0?.cerrada ?? false, caja_fecha: c0?.fecha ?? null };
    });
    return ok(c, { ...withDerivedStatus(row), payments: conCaja });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST / — alta manual
accountsReceivable.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = ARSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const d = parsed.data;
    const { data, error } = await db.from('accounts_receivable')
      .insert({ ...d, tenant_id: tenantId, status: 'pending' }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /:id
accountsReceivable.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const { data, error } = await db.from('accounts_receivable')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/pay — registrar abono
accountsReceivable.post('/:id/pay', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { amount, method, note, created_at, batch_id, cash_session_id, terminal } = await c.req.json() as {
      amount: number; method?: string; note?: string; created_at?: string;
      /** Agrupa los abonos de un mismo pago masivo. */
      batch_id?: string;
      /**
       * CAJA QUE RECIBIÓ EL ABONO, si se cobró en una.
       *
       * Sin esto el dinero del abono no aparecía en ningún cierre de caja: el
       * cajero cobraba ₡50.000 de una cuenta, los metía a la gaveta, y al
       * cerrar el sistema le marcaba ese mismo monto como SOBRANTE porque el
       * esperado solo contaba ventas.
       *
       * Va en NULL cuando el abono no pasó por una caja —la oficina, un
       * depósito, el repartidor en la calle—. Así ningún arqueo reclama plata
       * que nunca estuvo en esa gaveta.
       */
      cash_session_id?: string | null;
      /**
       * Número de caja de ESTA máquina, si el POS tiene caja por máquina.
       *
       * Con él, un cajero que entró a relevar el turno liga el abono a la
       * gaveta del equipo donde está parado, y no a la suya —que puede no
       * existir—. Sin él se usa la caja abierta de este usuario.
       */
      terminal?: number | null;
    };
    if (!amount || amount <= 0) return fail(c, 'Monto inválido', 422);

    const { data: ar } = await db.from('accounts_receivable')
      .select('total_amount, paid_amount').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!ar) return fail(c, 'Cuenta no encontrada', 404);

    const newPaid = Number(ar.paid_amount) + Number(amount);
    const status = newPaid >= Number(ar.total_amount) ? 'paid' : 'partial';

    const payment: Record<string, any> = {
      tenant_id: tenantId, receivable_id: id, amount, method: method ?? 'cash', note: note ?? null,
      user_id: c.get('userId') ?? null,   // quién cobró el abono (repartidor)
    };
    /**
     * LA CAJA LA RESUELVE EL SERVIDOR CUANDO EL CLIENTE NO LA MANDA.
     *
     * Antes dependía de que la pantalla tuviera la caja cargada en memoria. Si
     * no la tenía —se cobró desde el celular, desde una máquina donde el hook
     * todavía no había respondido, o el cajero no era el que abrió la gaveta—
     * el abono se guardaba sin caja y el cierre del POS no lo mencionaba.
     *
     * Se liga SOLO a la caja abierta de ESTE USUARIO (o a la de la terminal que
     * el POS declare). No «la única caja abierta del negocio», que es la regla
     * que parece práctica y está mal: el abono que cobra un REPARTIDOR en la
     * calle se ligaría a la caja del local, y entonces esa plata contaría dos
     * veces —una en el cierre de ruta, que la cuenta por repartidor y fecha, y
     * otra en el arqueo del local, donde nunca estuvo—.
     */
    let caja = cash_session_id ?? null;
    if (!caja) {
      try {
        const term = Number(terminal);
        let q = db.from('cash_sessions').select('id')
          .eq('tenant_id', tenantId).eq('status', 'open');
        q = (Number.isFinite(term) && term >= 1)
          ? q.eq('terminal', term)
          : q.eq('user_id', c.get('userId') ?? '');
        const { data: abierta } = await q
          .order('opening_date', { ascending: false }).limit(1).maybeSingle();
        caja = (abierta as any)?.id ?? null;

        /* Una máquina recién configurada puede tener su caja abierta de antes,
           sin terminal anotada: se adopta la del usuario, igual que hace el
           POS al buscar su caja activa. */
        if (!caja && Number.isFinite(term) && term >= 1) {
          const { data: suya } = await db.from('cash_sessions').select('id')
            .eq('tenant_id', tenantId).eq('user_id', c.get('userId') ?? '')
            .eq('status', 'open').is('terminal', null)
            .order('opening_date', { ascending: false }).limit(1).maybeSingle();
          caja = (suya as any)?.id ?? null;
        }
      } catch {
        /* Sin caja el abono se registra igual: perder el vínculo con el cierre
           es molesto, perder el abono sería un descuadre de plata. */
      }
    }
    if (caja) payment.cash_session_id = caja;
    // Abono registrado OFFLINE: usar el created_at real (no la hora del sync), para
    // que caiga dentro de la ventana del cierre del repartidor.
    if (typeof created_at === 'string' && !isNaN(Date.parse(created_at))) {
      payment.created_at = created_at;
    }
    if (batch_id) payment.batch_id = batch_id;

    let ins = await db.from('accounts_receivable_payments').insert(payment);
    // La columna `batch_id` es de la migración 89: si no corrió, el abono se
    // registra igual sin agrupar. Perder el vínculo del pago masivo es molesto;
    // perder el abono sería un descuadre de plata.
    if (ins.error && /batch_id/.test(ins.error.message ?? '')) {
      const { batch_id: _b, ...rest } = payment;
      ins = await db.from('accounts_receivable_payments').insert(rest);
    }
    // `cash_session_id` es de la migración 144: si no corrió, el abono se
    // registra igual (sin ligarse a la caja). Perder el vínculo con el cierre
    // es molesto; perder el abono sería un descuadre de plata.
    if (ins.error && /cash_session_id/.test(ins.error.message ?? '')) {
      const { cash_session_id: _s, ...rest } = payment;
      ins = await db.from('accounts_receivable_payments').insert(rest);
    }
    if (ins.error) throw new Error(ins.error.message);

    const patch: Record<string, any> = {
      paid_amount: newPaid, status, updated_at: new Date().toISOString(),
    };
    // Momento en que la cuenta queda CANCELADA. `updated_at` no sirve para esto:
    // cambia con cualquier edición posterior, así que la fecha de cancelación se
    // perdía apenas alguien tocaba la cuenta.
    if (status === 'paid') {
      patch.paid_at = payment.created_at ?? new Date().toISOString();
    }

    let upd = await db.from('accounts_receivable').update(patch).eq('id', id).select().single();
    if (upd.error && /paid_at/.test(upd.error.message ?? '')) {
      const { paid_at: _p, ...rest } = patch;
      upd = await db.from('accounts_receivable').update(rest).eq('id', id).select().single();
    }
    if (upd.error) throw new Error(upd.error.message);
    return ok(c, upd.data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * ¿LA CAJA QUE RECIBIÓ ESTOS ABONOS YA ESTÁ CERRADA?
 *
 * Anular un abono de una caja CERRADA mueve plata de un arqueo que ya se
 * firmó: ese turno queda con el monto del abono de más, y el cajero —que
 * contó bien— aparece con un sobrante que no cometió. No se prohíbe (el abono
 * mal puesto hay que poder quitarlo), pero tiene que decirse antes.
 */
async function estadoDeCajas(tenantId: string, ids: string[]) {
  const mapa = new Map<string, { cerrada: boolean; fecha: string | null }>();
  const limpios = [...new Set(ids.filter(Boolean))];
  if (limpios.length === 0) return mapa;
  for (let i = 0; i < limpios.length; i += 200) {
    const { data, error } = await db.from('cash_sessions')
      .select('id, status, closing_date')
      .eq('tenant_id', tenantId).in('id', limpios.slice(i, i + 200));
    if (error) break;   // sin el dato se sigue: el aviso es de más, no de menos
    for (const s of ((data ?? []) as any[])) {
      mapa.set(String(s.id), {
        cerrada: String(s.status ?? '') !== 'open',
        fecha: s.closing_date ?? null,
      });
    }
  }
  return mapa;
}

// POST /payments/:paymentId/void — ANULAR un abono. Solo administrador, gerente,
// contador o propietario. Borra el abono y recalcula el saldo de la cuenta.
const VOID_ROLES = new Set(['owner', 'admin', 'gerente', 'contador']);
accountsReceivable.post('/payments/:paymentId/void', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const role = String(c.get('role') ?? '');
    if (!VOID_ROLES.has(role)) {
      return fail(c, 'Solo el administrador, gerente o contador pueden anular abonos.', 403);
    }
    const { paymentId } = c.req.param();
    const body = await c.req.json().catch(() => ({} as any));
    /**
     * EL MOTIVO ES OBLIGATORIO.
     *
     * Anular mueve el saldo de un cliente y, si el abono entró por una caja,
     * también la plata de un arqueo. Sin motivo, al mes siguiente nadie puede
     * decir si fue un error de digitación, un cheque devuelto o un cobro que
     * nunca entró —y para el cliente las tres cosas significan algo distinto—.
     */
    const motivo = String(body?.reason ?? '').trim();
    if (motivo.length < 4) {
      return fail(c, 'Escribí por qué se anula el abono (ej: «error de digitación», «cheque devuelto»).', 422);
    }

    let pq: any = await db.from('accounts_receivable_payments')
      .select('id, receivable_id, amount, voided_at, cash_session_id')
      .eq('id', paymentId).eq('tenant_id', tenantId).maybeSingle();
    // `cash_session_id` es de la migración 144: sin ella se anula igual, solo
    // que no se puede avisar de la caja.
    if (pq.error && /cash_session_id/.test(pq.error.message ?? '')) {
      pq = await db.from('accounts_receivable_payments')
        .select('id, receivable_id, amount, voided_at')
        .eq('id', paymentId).eq('tenant_id', tenantId).maybeSingle();
    }
    const pay = pq.data;
    if (!pay) return fail(c, 'Abono no encontrado', 404);
    if ((pay as any).voided_at) return fail(c, 'El abono ya estaba anulado', 409);

    /* Caja ya cerrada: se avisa y se pide confirmar. Prohibirlo dejaría el
       abono mal puesto adentro para siempre; hacerlo callado descuadra el
       arqueo de otra persona sin que nadie se entere. */
    const caja = String((pay as any).cash_session_id ?? '');
    const estado = caja ? (await estadoDeCajas(tenantId, [caja])).get(caja) : undefined;
    const cajaCerrada = !!estado?.cerrada;
    if (cajaCerrada && !body?.force) {
      return c.json({
        success: false,
        error: 'Este abono entró por una caja que YA está cerrada. Al anularlo, ese arqueo '
          + `queda con ₡${Number((pay as any).amount || 0).toLocaleString('es-CR')} de más.`,
        caja_cerrada: true,
        caja_fecha: estado?.fecha ?? null,
        monto: Number((pay as any).amount || 0),
      }, 409);
    }

    const receivableId = (pay as any).receivable_id;
    // Borrado LÓGICO: se marca como anulado (con quién y cuándo). Si las columnas
    // aún no existen (migración 63 sin correr), cae a borrado físico.
    const marca: Record<string, any> = {
      voided_at: new Date().toISOString(),
      voided_by: c.get('userId') ?? null,
      void_reason: motivo,
    };
    let vUpd = await db.from('accounts_receivable_payments')
      .update(marca).eq('id', paymentId).eq('tenant_id', tenantId);
    // `void_reason` es de la migración 151: sin ella el abono se anula igual y
    // el motivo queda en la nota. Perder el motivo es malo; no poder anular un
    // abono mal puesto es peor.
    if (vUpd.error && /void_reason/.test(vUpd.error.message ?? '')) {
      const { void_reason: _r, ...rest } = marca;
      vUpd = await db.from('accounts_receivable_payments')
        .update(rest).eq('id', paymentId).eq('tenant_id', tenantId);
    }
    if (vUpd.error) {
      if (/voided_at|voided_by|column/.test(vUpd.error.message)) {
        await db.from('accounts_receivable_payments').delete().eq('id', paymentId).eq('tenant_id', tenantId);
      } else { throw new Error(vUpd.error.message); }
    }

    // Recalcular paid_amount = SUMA de los abonos NO anulados (así el saldo vuelve
    // EXACTO a como estaba antes de este abono, sin arrastrar errores de resta).
    let rows: any = await db.from('accounts_receivable_payments')
      .select('amount, voided_at').eq('receivable_id', receivableId).eq('tenant_id', tenantId);
    if (rows.error && /voided_at|column/.test(rows.error.message ?? '')) {
      rows = await db.from('accounts_receivable_payments')
        .select('amount').eq('receivable_id', receivableId).eq('tenant_id', tenantId);
    }
    const newPaid = ((rows.data ?? []) as any[])
      .filter(r => !r.voided_at).reduce((s, r) => s + Number(r.amount || 0), 0);

    const { data: ar } = await db.from('accounts_receivable')
      .select('total_amount').eq('id', receivableId).eq('tenant_id', tenantId).maybeSingle();
    const total = Number((ar as any)?.total_amount ?? 0);
    const status = newPaid <= 0 ? 'pending' : newPaid >= total ? 'paid' : 'partial';
    const patch: Record<string, any> = {
      paid_amount: newPaid, status, updated_at: new Date().toISOString(),
    };
    // Si la cuenta deja de estar cancelada, la fecha de cancelación se borra: una
    // cuenta con saldo y con fecha de cancelación es un dato que se contradice a
    // sí mismo, y después nadie sabe cuál de los dos creer.
    if (status !== 'paid') patch.paid_at = null;
    let upd = await db.from('accounts_receivable').update(patch)
      .eq('id', receivableId).eq('tenant_id', tenantId);
    if (upd.error && /paid_at/.test(upd.error.message ?? '')) {
      const { paid_at: _p, ...rest } = patch;
      upd = await db.from('accounts_receivable').update(rest)
        .eq('id', receivableId).eq('tenant_id', tenantId);
    }

    return ok(c, {
      voided: true, amount: (pay as any).amount, new_paid: newPaid,
      /** La pantalla lo dice: si la caja estaba cerrada, ese arqueo cambió. */
      caja_cerrada: cajaCerrada,
      caja_fecha: estado?.fecha ?? null,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

accountsReceivable.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db.from('accounts_receivable').delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// COMPROBANTE DE UN ABONO
// ══════════════════════════════════════════════════════════════════════════
//
// body: { customer_id?, customer_name?, amount, document_type, batch_id?,
//         payment_method? }
//
// ── Qué NO hace, y por qué ────────────────────────────────────────────────
// No se emite por cuentas cuyo ingreso YA se declaró a Hacienda. Una venta a
// crédito documentada electrónicamente emitió su comprobante al venderse, con
// condición de venta «crédito»; emitir otro al cobrar declararía el mismo
// ingreso dos veces.
//
// «Ya se declaró» = la factura de origen tiene CLAVE de Hacienda. No basta con
// que exista una factura: una venta con tiquete CORRIENTE crea su factura
// interna y nunca se declaró, así que al cobrarla sí corresponde emitir.
//
// Si el front manda `account_ids`, acá se recalcula el monto elegible contra la
// base: una regla fiscal no puede vivir solo en la pantalla.
//
// ── Sin caja ──────────────────────────────────────────────────────────────
// `cash_session_id` queda en NULL a propósito. Un abono se cobra muchas veces
// fuera del POS —en la oficina, o por depósito—, y meterlo al arqueo haría que
// al cajero le sobre plata que nunca pasó por su gaveta.
accountsReceivable.post('/emit-receipt', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const b = await c.req.json().catch(() => ({} as any));

    let amount = Number(b?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return fail(c, 'Monto inválido', 422);

    // Verificación contra la BASE de qué cuentas no se han declarado. El front
    // ya filtró, pero esto es lo que impide que un cliente viejo, una llamada
    // directa o un error de pantalla dupliquen un ingreso ante Hacienda.
    const accountIds: string[] = Array.isArray(b?.account_ids) ? b.account_ids : [];
    if (accountIds.length > 0) {
      const { data: accs } = await db.from('accounts_receivable')
        .select('id, invoice_id').eq('tenant_id', tenantId).in('id', accountIds);
      const invIds = [...new Set((accs ?? []).map((a: any) => a.invoice_id).filter(Boolean))];
      const declared = new Set<string>();
      if (invIds.length) {
        const { data: invs } = await db.from('invoices')
          .select('id, fe_clave').in('id', invIds as string[]);
        for (const i of (invs ?? []) as any[]) if (i.fe_clave) declared.add(i.id);
      }
      const elegibles = (accs ?? []).filter((a: any) => !a.invoice_id || !declared.has(a.invoice_id));
      if (elegibles.length === 0) {
        return fail(c,
          'Todas esas cuentas ya se declararon a Hacienda al venderse. '
          + 'Emitir otro comprobante duplicaría el ingreso.', 409);
      }
      // No se topa el monto contra el saldo: este endpoint se llama DESPUÉS de
      // aplicar los abonos, así que el saldo de esas cuentas ya es cero y el
      // tope daría siempre 0. Lo que se valida acá es que exista al menos una
      // cuenta sin declarar; el monto lo calcula quien aplicó los abonos, que es
      // el único que sabe cuánto le tocó a cada una.
    }

    const docType = String(b?.document_type ?? '');
    if (!['ticket', 'tiquete_electronico', 'factura_electronica'].includes(docType)) {
      return fail(c, 'Tipo de comprobante inválido', 422);
    }

    // El monto recibido YA incluye el impuesto: el cliente pagó eso y el
    // comprobante tiene que decir eso. Se despeja la base con el mismo criterio
    // del POS (redondeo a colón), para que el total salga exacto.
    const ivaRate = Number(b?.iva_rate ?? 13);
    const base = ivaRate > 0 ? Math.round((amount / (1 + ivaRate / 100)) * 100) / 100 : amount;
    const tax = Math.round(amount - base);
    const total = Math.round(base) + tax;

    const floor = await consecutivoFloor(tenantId);
    let finalNumber = await nextInvoiceNumber(tenantId, 0, floor);
    let inv: any = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await db.from('invoices').insert({
        tenant_id: tenantId,
        invoice_number: finalNumber,
        customer_id: b?.customer_id ?? null,
        customer_name: b?.customer_name ?? null,
        subtotal: base, tax_amount: tax, total,
        discount_amount: 0,
        payment_method: b?.payment_method ?? 'cash',
        status: 'completed',
        // Sin caja: el abono no entra al arqueo (ver arriba).
        cash_session_id: null,
        cashier_id: c.get('userId') ?? null,
        document_type: docType === 'ticket' ? 'ticket' : docType,
        notes: b?.batch_id ? `Abono a cuenta · lote ${b.batch_id}` : 'Abono a cuenta',
        issued_at: new Date().toISOString(),
      }).select().single();

      if (!res.error) { inv = res.data; break; }
      const msg = (res.error as any)?.message ?? '';
      const isDup = (res.error as any)?.code === '23505' || /duplicate key|invoice_number_key/i.test(msg);
      if (!isDup) throw new Error(msg);
      finalNumber = await nextInvoiceNumber(tenantId, attempt + 1, floor);
    }
    if (!inv) return fail(c, 'No se pudo generar el comprobante (número duplicado)', 409);

    // Una sola línea: «Abono a cuenta». La cuenta manual no tiene productos de
    // dónde sacar un detalle, y inventarlo sería declarar una venta que no fue.
    await db.from('invoice_items').insert({
      invoice_id: inv.id,
      product_id: null,
      product_name: 'Abono a cuenta',
      quantity: 1,
      unit_price: base,
      subtotal: base,
    }).then(() => {}, (e: any) => console.warn('[abono] línea:', e?.message));

    // Electrónico: se emite. Si Hacienda lo rechaza, la factura queda creada con
    // el error registrado — el abono ya se recibió y no se deshace por esto.
    if (docType !== 'ticket') {
      try {
        return await emitInvoiceCore(c, tenantId, inv.id, {});
      } catch (e: any) {
        return ok(c, {
          invoice_id: inv.id, invoice_number: inv.invoice_number,
          emitted: false, error: e?.message ?? 'No se pudo emitir',
        }, 201);
      }
    }

    return ok(c, {
      invoice_id: inv.id, invoice_number: inv.invoice_number, emitted: false,
    }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default accountsReceivable;
