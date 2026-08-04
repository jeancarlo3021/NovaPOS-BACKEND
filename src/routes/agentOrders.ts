import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * Pedidos del agente hacia CAJA.
 *
 * El agente arma el pedido y lo envía; le aparece al cajero en su bandeja. El
 * cajero lo TOMA (queda reservado para él, para que dos cajeros no cobren el
 * mismo pedido), lo carga en el POS y lo cobra con el flujo normal. Al cobrarse
 * se marca `charged`, se liga a la factura y se calcula la comisión del agente.
 */
const agentOrders = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const ItemSchema = z.object({
  product_id:   z.string().uuid().optional().nullable(),
  product_name: z.string().min(1),
  quantity:     z.number().positive(),
  unit_price:   z.number().nonnegative(),
  subtotal:     z.number().nonnegative(),
  notes:        z.string().optional().nullable(),
});

const totalOf = (items: any[]) =>
  Math.round(items.reduce((s, it) => s + Number(it.subtotal ?? 0), 0) * 100) / 100;

/** Consecutivo legible del pedido (P-000001). */
async function nextNumber(tenantId: string): Promise<string> {
  const { data } = await db.from('agent_orders')
    .select('number').eq('tenant_id', tenantId)
    .order('created_at', { ascending: false }).limit(1);
  const last = String((data ?? [])[0]?.number ?? '');
  const n = parseInt(last.replace(/\D/g, ''), 10);
  return `P-${String((Number.isFinite(n) ? n : 0) + 1).padStart(6, '0')}`;
}

// GET /me — agente vinculado al usuario que está logueado. Así el pedido sale a
// su nombre sin que tenga que elegirse a sí mismo en una lista.
agentOrders.get('/me', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');

    // 1) Vinculado explícitamente (lo normal cuando el agente se creó con usuario).
    const { data: linked } = await db.from('sales_agents')
      .select('id, name, commission_percent')
      .eq('tenant_id', tenantId).eq('user_id', userId).eq('is_active', true).maybeSingle();
    if (linked) return ok(c, linked);

    // 2) Sin vínculo: se busca por el nombre o el correo del usuario logueado y,
    //    si aparece, se VINCULA para que la próxima sea directa. Cubre los agentes
    //    creados antes de que existiera la creación de usuario, sin obligar a
    //    reconfigurarlos a mano.
    const { data: u } = await db.from('users')
      .select('full_name, email').eq('id', userId).maybeSingle();
    const fullName = String((u as any)?.full_name ?? '').trim();
    const email = String((u as any)?.email ?? '').trim().toLowerCase();
    if (!fullName && !email) return ok(c, null);

    const { data: candidates } = await db.from('sales_agents')
      .select('id, name, commission_percent, email, user_id')
      .eq('tenant_id', tenantId).eq('is_active', true);
    const match = (candidates ?? []).find((a: any) => {
      if (a.user_id) return false;                        // ya es de otro usuario
      if (email && String(a.email ?? '').toLowerCase() === email) return true;
      return !!fullName && String(a.name ?? '').trim().toLowerCase() === fullName.toLowerCase();
    });
    if (!match) return ok(c, null);

    try {
      await db.from('sales_agents')
        .update({ user_id: userId, updated_at: new Date().toISOString() })
        .eq('id', (match as any).id).eq('tenant_id', tenantId);
    } catch (e: any) { console.warn('[agent-orders/me] no se pudo vincular:', e?.message); }

    return ok(c, {
      id: (match as any).id,
      name: (match as any).name,
      commission_percent: (match as any).commission_percent,
      auto_linked: true,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /?status=pending — bandeja del cajero. Sin filtro, los pendientes.
agentOrders.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status') || 'pending';
    const agentId = c.req.query('agent_id');
    let q = db.from('agent_orders')
      .select('*, agent_order_items(*)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }).limit(500);
    if (status !== 'all') q = q.eq('status', status);
    if (agentId) q = q.eq('agent_id', agentId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ok(c, (data ?? []).map((o: any) => ({
      ...o, items: o.agent_order_items ?? [], item_count: (o.agent_order_items ?? []).length,
    })));
  } catch (err: any) { return fail(c, err.message, 500); }
});

agentOrders.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('agent_orders')
      .select('*, agent_order_items(*)')
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Pedido no encontrado', 404);
    return ok(c, { ...data, items: (data as any).agent_order_items ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST / — el agente ENVÍA el pedido a caja.
// body: { agent_id?, customer_id?, customer_name?, customer_phone?, notes?, items[] }
agentOrders.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({} as any));
    const parsed = z.array(ItemSchema).min(1).safeParse(body?.items);
    if (!parsed.success) return fail(c, 'El pedido no tiene líneas: ' + parsed.error.message, 422);

    // Nombre del agente como snapshot: el pedido tiene que seguir legible aunque
    // después se desactive o se le cambie el nombre.
    let agentName: string | null = body?.agent_name ?? null;
    if (body?.agent_id && !agentName) {
      const { data: a } = await db.from('sales_agents')
        .select('name').eq('id', body.agent_id).eq('tenant_id', tenantId).maybeSingle();
      agentName = (a as any)?.name ?? null;
    }

    const { data: created, error } = await db.from('agent_orders').insert({
      tenant_id: tenantId,
      agent_id: body?.agent_id ?? null,
      agent_name: agentName,
      number: await nextNumber(tenantId),
      status: 'pending',
      customer_id: body?.customer_id ?? null,
      customer_name: body?.customer_name ?? null,
      customer_phone: body?.customer_phone ?? null,
      notes: body?.notes ?? null,
      // Tipo de comprobante que pidió el cliente. Lo elige el AGENTE, que es
      // quien habla con él; el cajero solo lo respeta al cobrar.
      document_type: ['ticket', 'tiquete_electronico', 'factura_electronica']
        .includes(String(body?.document_type)) ? body.document_type : 'ticket',
      total: totalOf(parsed.data),
      created_by: userId,
    }).select('*').single();
    // Resiliente: si la migración 78 no corrió, se reintenta sin document_type.
    if (error && /document_type/i.test(error.message)) {
      const retry = await db.from('agent_orders').insert({
        tenant_id: tenantId, agent_id: body?.agent_id ?? null, agent_name: agentName,
        number: await nextNumber(tenantId), status: 'pending',
        customer_id: body?.customer_id ?? null, customer_name: body?.customer_name ?? null,
        customer_phone: body?.customer_phone ?? null, notes: body?.notes ?? null,
        total: totalOf(parsed.data), created_by: userId,
      }).select('*').single();
      if (retry.error) throw new Error(retry.error.message);
      const rows0 = parsed.data.map(it => ({ ...it, order_id: (retry.data as any).id }));
      const { error: i0 } = await db.from('agent_order_items').insert(rows0);
      if (i0) throw new Error(i0.message);
      return ok(c, { ...(retry.data as any), items: rows0 }, 201);
    }
    if (error) throw new Error(error.message);

    const rows = parsed.data.map(it => ({ ...it, order_id: (created as any).id }));
    const { error: iErr } = await db.from('agent_order_items').insert(rows);
    if (iErr) throw new Error(iErr.message);

    return ok(c, { ...(created as any), items: rows }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/take — el cajero lo reserva para cobrarlo. Evita que dos cajeros
// cobren el mismo pedido: solo pasa de 'pending' a 'taken' una vez.
agentOrders.post('/:id/take', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const { data, error } = await db.from('agent_orders').update({
      status: 'taken', taken_by: userId,
      taken_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', c.req.param('id')).eq('tenant_id', tenantId).eq('status', 'pending')
      .select('*, agent_order_items(*)').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Ese pedido ya lo tomó otro cajero (o fue anulado).', 409);
    return ok(c, { ...data, items: (data as any).agent_order_items ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/release — devuelve el pedido a la bandeja (el cajero no lo cobró).
agentOrders.post('/:id/release', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('agent_orders').update({
      status: 'pending', taken_by: null, taken_at: null, updated_at: new Date().toISOString(),
    }).eq('id', c.req.param('id')).eq('tenant_id', tenantId).eq('status', 'taken').select('*').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'El pedido no estaba tomado', 409);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/charge — cobrado. body: { invoice_id?, total? }
// Calcula la comisión con el % vigente del agente.
agentOrders.post('/:id/charge', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));

    const { data: order } = await db.from('agent_orders')
      .select('id, agent_id, total, status').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!order) return fail(c, 'Pedido no encontrado', 404);
    if ((order as any).status === 'charged') return fail(c, 'El pedido ya fue cobrado', 409);

    const total = Number(body?.total ?? (order as any).total ?? 0);
    let commission = 0;
    if ((order as any).agent_id) {
      const { data: a } = await db.from('sales_agents')
        .select('commission_percent').eq('id', (order as any).agent_id).maybeSingle();
      const pct = Number((a as any)?.commission_percent ?? 0);
      commission = Math.round(total * (pct / 100) * 100) / 100;
    }

    const { data, error } = await db.from('agent_orders').update({
      status: 'charged',
      invoice_id: body?.invoice_id ?? null,
      total,
      commission_amount: commission,
      charged_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);

    // Marcar el vendedor en la factura (para reportes aunque el pedido se borre).
    if (body?.invoice_id && (order as any).agent_id) {
      try {
        await db.from('invoices').update({ sales_agent_id: (order as any).agent_id })
          .eq('id', body.invoice_id).eq('tenant_id', tenantId);
      } catch { /* migración 77 sin correr: no es crítico */ }
    }
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

agentOrders.post('/:id/cancel', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('agent_orders').update({
      status: 'cancelled', updated_at: new Date().toISOString(),
    }).eq('id', c.req.param('id')).eq('tenant_id', tenantId)
      .in('status', ['pending', 'taken']).select('*').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'El pedido no se puede anular (ya fue cobrado)', 409);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default agentOrders;
