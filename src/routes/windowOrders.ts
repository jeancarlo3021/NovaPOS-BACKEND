import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { hasFeature } from '../services/planFeatures.js';

/**
 * Ventanita: la FILA de pedidos del mostrador.
 *
 * El cobro no pasa por acá — eso ya lo hace el POS y termina en una factura.
 * Esta tabla solo responde una pregunta que hoy vive en la cabeza del que
 * despacha: qué hay en cocina, en qué orden entró y qué se puede entregar.
 * Cuando hay cola, esa memoria falla.
 */
const windowOrders = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/** Fecha de hoy en Costa Rica. El día del negocio no es el UTC. */
function crToday(): string {
  return new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
}

// GET /?status= — la fila. Por defecto, lo que sigue vivo.
windowOrders.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status');
    let q = db.from('window_orders')
      .select('*').eq('tenant_id', tenantId).eq('day', crToday())
      .order('number', { ascending: true }).limit(300);
    if (status) q = q.eq('status', status);
    else q = q.in('status', ['pending', 'ready']);   // lo entregado sale de la fila
    const { data, error } = await q;
    // Sin la migración 87 la ventanita no puede operar, pero el resto del POS sí:
    // se devuelve vacío y con aviso, no un error que rompa la pantalla.
    if (error) return ok(c, { rows: [], available: false, message: error.message });
    return ok(c, { rows: data ?? [], available: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

const CreateSchema = z.object({
  invoice_id: z.string().uuid().optional().nullable(),
  customer_name: z.string().optional().nullable(),
  /** Bipper entregado al cliente. Texto: vienen rotulados «A3», «Rojo-4»… */
  bipper: z.string().max(12).optional().nullable(),
  items_summary: z.string().optional().nullable(),
  total: z.number().nonnegative().optional().default(0),
  notes: z.string().optional().nullable(),
});

// POST / — mete un pedido a la fila y devuelve su número.
//
// Se llama DESPUÉS de cobrar. Si esto fallara, la venta ya está hecha: por eso
// el POS lo trata como accesorio y nunca deja la caja trabada por la fila.
windowOrders.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!(await hasFeature(tenantId, 'window_service'))) {
      return fail(c, 'La ventanita no está incluida en tu plan.', 403);
    }
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, parsed.error.errors[0]?.message ?? 'Datos inválidos', 422);
    const b = parsed.data;

    // Se reintenta ante choque de número: con dos cajas despachando a la vez, el
    // índice único es el que decide, y perder la carrera solo significa tomar el
    // siguiente. Fallarle al cajero por eso sería absurdo.
    for (let attempt = 0; attempt < 6; attempt++) {
      let next = 1;
      try {
        const { data: n } = await db.rpc('next_window_number', { p_tenant: tenantId });
        next = Number(Array.isArray(n) ? n[0] : n) || 1;
      } catch {
        const { data: last } = await db.from('window_orders')
          .select('number').eq('tenant_id', tenantId).eq('day', crToday())
          .order('number', { ascending: false }).limit(1).maybeSingle();
        next = Number((last as any)?.number ?? 0) + 1;
      }
      next += attempt;   // en el reintento se salta al siguiente

      const { data, error } = await db.from('window_orders').insert({
        tenant_id: tenantId, number: next, day: crToday(),
        invoice_id: b.invoice_id ?? null,
        customer_name: b.customer_name ?? null,
        bipper: b.bipper?.trim() || null,
        items_summary: b.items_summary ?? null,
        total: b.total ?? 0, notes: b.notes ?? null,
      }).select('*').single();

      if (!error) return ok(c, data, 201);
      if (!/duplicate|unique/i.test(error.message)) throw new Error(error.message);
    }
    return fail(c, 'No se pudo asignar un número de orden. Intentá de nuevo.', 409);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/status — mueve el pedido en la fila.
// body: { status: 'pending'|'ready'|'delivered'|'cancelled' }
windowOrders.post('/:id/status', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({} as any));
    const status = String(b?.status ?? '');
    if (!['pending', 'ready', 'delivered', 'cancelled'].includes(status)) {
      return fail(c, 'Estado inválido', 422);
    }
    const patch: any = { status };
    // Las marcas de tiempo permiten medir cuánto tarda la cocina, que es la
    // pregunta que se hace un negocio de ventanita cuando la fila crece.
    if (status === 'ready') patch.ready_at = new Date().toISOString();
    if (status === 'delivered') patch.delivered_at = new Date().toISOString();

    const { data, error } = await db.from('window_orders')
      .update(patch).eq('id', id).eq('tenant_id', tenantId).select('*').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(c, 'Pedido no encontrado', 404);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /stats — cuánto tarda la cocina hoy.
windowOrders.get('/stats', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('window_orders')
      .select('status, created_at, ready_at')
      .eq('tenant_id', tenantId).eq('day', crToday()).limit(500);
    if (error) return ok(c, { available: false });

    const rows = (data ?? []) as any[];
    const done = rows.filter(r => r.ready_at);
    const mins = done.map(r =>
      (new Date(r.ready_at).getTime() - new Date(r.created_at).getTime()) / 60000);
    return ok(c, {
      available: true,
      total: rows.length,
      pending: rows.filter(r => r.status === 'pending').length,
      ready: rows.filter(r => r.status === 'ready').length,
      avg_minutes: mins.length ? mins.reduce((s, x) => s + x, 0) / mins.length : null,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default windowOrders;
