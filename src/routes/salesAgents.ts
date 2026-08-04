import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { endOfDay } from '../utils/dateRange.js';

/** Agentes de venta: alta, edición y su reporte de ventas y comisiones. */
const salesAgents = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const AgentSchema = z.object({
  name:               z.string().min(1),
  user_id:            z.string().uuid().optional().nullable(),
  phone:              z.string().optional().nullable(),
  email:              z.string().optional().nullable(),
  identification:     z.string().optional().nullable(),
  commission_percent: z.number().min(0).max(100).optional(),
  is_active:          z.boolean().optional(),
  notes:              z.string().optional().nullable(),
});

salesAgents.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('sales_agents')
      .select('*').eq('tenant_id', tenantId).order('name');
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST / — crea el agente y, si se pide, TAMBIÉN su usuario del sistema.
// body: { ...agente, create_user?: true, username, password }
// El usuario queda con rol 'agente', aparece en Usuarios y puede entrar a armar
// pedidos. Sin esto había que crear el agente y el usuario por separado y
// acordarse de vincularlos a mano.
salesAgents.post('/', async (c) => {
  let createdAuthId: string | null = null;
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({} as any));
    const parsed = AgentSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    let userId: string | null = parsed.data.user_id ?? null;

    if (body?.create_user) {
      const rawUser = String(body?.username ?? '').trim();
      const password = String(body?.password ?? '');
      if (!rawUser) return fail(c, 'Falta el usuario para el acceso del agente.', 422);
      if (password.length < 6) return fail(c, 'La contraseña debe tener al menos 6 caracteres.', 422);

      // Igual que en Usuarios: un "usuario" sin @ se vuelve un correo interno.
      const email = rawUser.includes('@') ? rawUser.toLowerCase() : `${rawUser.toLowerCase()}@nexoerp.local`;

      const { data: dup } = await db.from('users').select('id').eq('email', email).maybeSingle();
      if (dup) {
        const display = email.replace('@nexoerp.local', '');
        return fail(c, `Ya existe un usuario con el nombre "${display}". Elegí otro.`, 409);
      }

      const { data: authData, error: authError } = await db.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (authError) {
        if (/already (registered|exists)/i.test(authError.message)) {
          return fail(c, `Ya existe un usuario con el nombre "${email.replace('@nexoerp.local', '')}". Elegí otro.`, 409);
        }
        throw new Error(authError.message);
      }
      if (!authData.user) throw new Error('No se pudo crear el usuario');
      createdAuthId = authData.user.id;

      const { error: uErr } = await db.from('users').insert({
        id: authData.user.id,
        email,
        full_name: parsed.data.name,
        role: 'agente',
        phone: parsed.data.phone ?? null,
        tenant_id: tenantId,
      });
      if (uErr) throw new Error(uErr.message);

      // Vincular en user_tenants para que pueda leer su tenant vía RLS.
      const { error: utErr } = await db.from('user_tenants').upsert({
        user_id: authData.user.id, tenant_id: tenantId, role: 'staff', is_default: true,
      }, { onConflict: 'user_id,tenant_id' });
      if (utErr) console.warn('[sales-agents] user_tenants link falló:', utErr.message);

      userId = authData.user.id;
    }

    const { data, error } = await db.from('sales_agents')
      .insert({ ...parsed.data, user_id: userId, tenant_id: tenantId }).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, { ...data, user_created: !!createdAuthId }, 201);
  } catch (err: any) {
    // Si el agente no se pudo guardar, no dejamos un usuario huérfano.
    if (createdAuthId) {
      try { await db.auth.admin.deleteUser(createdAuthId); } catch { /* ignore */ }
      try { await db.from('users').delete().eq('id', createdAuthId); } catch { /* ignore */ }
    }
    return fail(c, err.message, 500);
  }
});

salesAgents.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = AgentSchema.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const { data, error } = await db.from('sales_agents')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// DELETE /:id — se DESACTIVA en vez de borrar: los pedidos y comisiones históricas
// tienen que seguir apuntando a alguien.
salesAgents.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { error } = await db.from('sales_agents')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true, deactivated: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /report?from=&to= — ventas COBRADAS y comisión por agente.
salesAgents.get('/report', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = c.req.query('to');

    let q = db.from('agent_orders')
      .select('id, agent_id, agent_name, number, total, commission_amount, charged_at, customer_name, invoice_id')
      .eq('tenant_id', tenantId).eq('status', 'charged').limit(5000);
    if (from) q = q.gte('charged_at', from);
    if (to)   q = q.lte('charged_at', endOfDay(to));
    const { data: orders, error } = await q;
    if (error) throw new Error(error.message);

    const { data: agents } = await db.from('sales_agents')
      .select('id, name, commission_percent').eq('tenant_id', tenantId);
    const byId = new Map((agents ?? []).map((a: any) => [a.id, a]));

    const acc = new Map<string, any>();
    for (const o of (orders ?? []) as any[]) {
      const key = o.agent_id ?? 'sin-agente';
      const cur = acc.get(key) ?? {
        agent_id: o.agent_id ?? null,
        agent_name: byId.get(o.agent_id)?.name ?? o.agent_name ?? '(sin agente)',
        commission_percent: Number(byId.get(o.agent_id)?.commission_percent ?? 0),
        orders: 0, total: 0, commission: 0,
      };
      cur.orders += 1;
      cur.total += Number(o.total ?? 0);
      cur.commission += Number(o.commission_amount ?? 0);
      acc.set(key, cur);
    }
    const rows = [...acc.values()].sort((a, b) => b.total - a.total);
    return ok(c, {
      rows,
      orders: orders ?? [],
      totals: {
        orders: rows.reduce((s, r) => s + r.orders, 0),
        total: Math.round(rows.reduce((s, r) => s + r.total, 0) * 100) / 100,
        commission: Math.round(rows.reduce((s, r) => s + r.commission, 0) * 100) / 100,
      },
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default salesAgents;
