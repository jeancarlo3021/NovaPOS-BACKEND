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
});
const CloseSchema = z.object({
  closing_amount:  z.number().nonnegative().optional(),
  closing_balance: z.number().nonnegative().optional(), // alias for backward compat
  closing_usd: z.number().nonnegative().optional(),     // dólares contados en cierre
  notes: z.string().optional().nullable(),
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
    // Sesión de caja por USUARIO: cada cajero tiene la suya.
    const { data, error } = await db.from('cash_sessions').select('*')
      .eq('tenant_id', tenantId).eq('user_id', userId).eq('status', 'open')
      .order('opening_date', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
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
    const { data: abiertas } = await db.from('cash_sessions')
      .select('*').eq('tenant_id', tenantId).eq('user_id', userId).eq('status', 'open')
      .order('opening_date', { ascending: false }).limit(2);

    if ((abiertas ?? []).length > 0) {
      const actual: any = (abiertas ?? [])[0];
      if ((abiertas ?? []).length > 1) {
        console.warn(`[caja] el usuario ${userId} tiene ${(abiertas ?? []).length}+ cajas abiertas`);
      }
      // Se devuelve LA QUE YA ESTÁ para que el POS la adopte, en vez de dejar al
      // cajero trabado con "Ya tenés una caja abierta" sin poder hacer nada.
      return c.json({
        success: false,
        error: 'Ya tenés una caja abierta',
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
    }).select().single();
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

    return ok(c, {
      invoices: candidatas,
      source: candidatas.length > 0 ? 'window' : 'empty',
      session_id: id,
      window: { from: desde, to: hasta },
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

    const { data, error } = await db.from('cash_sessions').update({
      closing_amount: parsed.data.closing_amount,
      closing_usd:    parsed.data.closing_usd ?? null,
      closing_date:   new Date().toISOString(),
      status:         'closed',
      notes:          parsed.data.notes,
      updated_at:     new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
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
