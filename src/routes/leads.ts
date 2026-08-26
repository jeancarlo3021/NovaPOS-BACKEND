import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * Seguimiento de clientes interesados. Ver migrations/97_leads.sql
 *
 * El seguimiento vive por su HISTORIA: cada llamada, cada WhatsApp, cada visita
 * quedan como interacción con su fecha. El estado del seguimiento se deduce de
 * lo que se hizo, no de lo que alguien recuerda.
 */
const leads = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const STATUSES = ['nuevo', 'contactado', 'cotizado', 'negociacion', 'ganado', 'perdido'] as const;

const LeadSchema = z.object({
  customer_id: z.string().uuid().optional().nullable(),
  customer_name: z.string().min(1),
  phone: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  zone: z.string().optional().nullable(),
  agent_id: z.string().uuid().optional().nullable(),
  agent_name: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  interest: z.string().optional().nullable(),
  estimated_amount: z.number().nonnegative().optional().default(0),
  next_follow_up: z.string().optional().nullable(),
  status: z.enum(STATUSES).optional(),
});

const InteractionSchema = z.object({
  kind: z.string().optional().default('llamada'),
  note: z.string().optional().nullable(),
  happened_at: z.string().optional().nullable(),
  next_follow_up: z.string().optional().nullable(),
  status: z.enum(STATUSES).optional(),
});

/** Consecutivo legible del seguimiento. */
async function nextNumber(tenantId: string): Promise<string> {
  const { count } = await db.from('leads')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  return `SEG-${String((count ?? 0) + 1).padStart(5, '0')}`;
}

const crToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });

/** Roles que ven la cartera COMPLETA. El resto solo ve lo suyo. */
const MANAGERS = new Set(['owner', 'admin', 'gerente']);

/**
 * Alcance del usuario sobre los seguimientos.
 *
 * Un agente ve SOLO los interesados que él registró o que tiene asignados: la
 * cartera de un compañero no es asunto suyo, y con todos a la vista cualquiera
 * puede llamar al cliente de otro y arruinar la venta (y la comisión).
 */
async function leadScope(c: any): Promise<{ manager: boolean; userId: string; agentId: string | null }> {
  const userId = c.get('userId');
  const tenantId = c.get('tenantId');

  // El rol del JWT puede venir vacío según por dónde entre: se confirma contra
  // la tabla, que es la fuente de verdad.
  let role = String(c.get('role') ?? '');
  if (!role && userId) {
    const { data: u } = await db.from('users').select('role').eq('id', userId).maybeSingle();
    role = String((u as any)?.role ?? '');
  }
  if (MANAGERS.has(role)) return { manager: true, userId, agentId: null };

  const { data: agent } = await db.from('sales_agents')
    .select('id').eq('tenant_id', tenantId).eq('user_id', userId).maybeSingle();
  return { manager: false, userId, agentId: (agent as any)?.id ?? null };
}

/** ¿Este usuario puede tocar este seguimiento? */
function canSee(lead: any, scope: { manager: boolean; userId: string; agentId: string | null }): boolean {
  if (scope.manager) return true;
  if (scope.agentId && String(lead.agent_id ?? '') === scope.agentId) return true;
  return String(lead.created_by ?? '') === scope.userId;
}

// GET / — seguimientos. ?status= &agent_id= &q= &due=1 (solo los que ya tocaba)
leads.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status');
    const agentId = c.req.query('agent_id');
    const q = c.req.query('q');
    const due = c.req.query('due') === '1';

    const scope = await leadScope(c);
    let query = db.from('leads').select('*').eq('tenant_id', tenantId)
      .order('updated_at', { ascending: false }).limit(1000);

    // Un agente ve lo suyo: lo que registró o lo que tiene asignado.
    if (!scope.manager) {
      query = scope.agentId
        ? query.or(`agent_id.eq.${scope.agentId},created_by.eq.${scope.userId}`)
        : query.eq('created_by', scope.userId);
    }

    if (status && status !== 'all') {
      // 'abiertos' = todo lo que sigue en juego, que es la vista de trabajo.
      if (status === 'abiertos') query = query.not('status', 'in', '("ganado","perdido")');
      else query = query.eq('status', status);
    }
    if (agentId) query = query.eq('agent_id', agentId);
    if (q) query = query.or(`customer_name.ilike.%${q}%,phone.ilike.%${q}%,interest.ilike.%${q}%,number.ilike.%${q}%`);
    if (due) {
      query = query.lte('next_follow_up', crToday()).not('status', 'in', '("ganado","perdido")');
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /summary — cuántos hay en cada etapa y cuántos con seguimiento vencido.
leads.get('/summary', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const scope = await leadScope(c);
    let sq = db.from('leads')
      .select('status, next_follow_up, estimated_amount').eq('tenant_id', tenantId).limit(5000);
    if (!scope.manager) {
      sq = scope.agentId
        ? sq.or(`agent_id.eq.${scope.agentId},created_by.eq.${scope.userId}`)
        : sq.eq('created_by', scope.userId);
    }
    const { data, error } = await sq;
    if (error) throw new Error(error.message);

    const hoy = crToday();
    const byStatus: Record<string, { count: number; amount: number }> = {};
    let vencidos = 0, hoyCount = 0;
    for (const r of (data ?? []) as any[]) {
      const st = String(r.status ?? 'nuevo');
      byStatus[st] ??= { count: 0, amount: 0 };
      byStatus[st].count++;
      byStatus[st].amount += Number(r.estimated_amount ?? 0);
      if (st !== 'ganado' && st !== 'perdido' && r.next_follow_up) {
        if (r.next_follow_up < hoy) vencidos++;
        else if (r.next_follow_up === hoy) hoyCount++;
      }
    }
    return ok(c, { by_status: byStatus, overdue: vencidos, today: hoyCount });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /:id — el seguimiento con toda su historia.
leads.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const { data: lead } = await db.from('leads')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!lead) return fail(c, 'Seguimiento no encontrado', 404);
    if (!canSee(lead, await leadScope(c))) {
      return fail(c, 'Este seguimiento es de otro agente', 403);
    }

    const { data: inter } = await db.from('lead_interactions')
      .select('*').eq('lead_id', id).eq('tenant_id', tenantId)
      .order('happened_at', { ascending: false }).limit(200);

    return ok(c, { ...(lead as any), interactions: inter ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

leads.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const parsed = LeadSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, 'Datos incompletos: ' + parsed.error.message, 422);

    const { data, error } = await db.from('leads').insert({
      tenant_id: tenantId,
      number: await nextNumber(tenantId),
      ...parsed.data,
      next_follow_up: parsed.data.next_follow_up || null,
      status: parsed.data.status ?? 'nuevo',
      created_by: userId,
    }).select('*').single();
    if (error) throw new Error(error.message);

    // El alta ES el primer contacto: si no queda registrado, el historial arranca
    // vacío y no se sabe cuándo apareció el cliente.
    await db.from('lead_interactions').insert({
      tenant_id: tenantId, lead_id: (data as any).id,
      kind: parsed.data.source ?? 'otro',
      note: parsed.data.interest ? `Pidió: ${parsed.data.interest}` : 'Primer contacto',
      status_after: (data as any).status,
      next_follow_up: parsed.data.next_follow_up || null,
      created_by: userId,
    });

    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** Carga el seguimiento verificando que el usuario pueda tocarlo. */
async function loadOwned(c: any, id: string) {
  const tenantId = c.get('tenantId');
  const { data: lead } = await db.from('leads')
    .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
  if (!lead) return { lead: null, denied: false };
  const scope = await leadScope(c);
  return { lead, denied: !canSee(lead, scope) };
}

leads.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const guard = await loadOwned(c, c.req.param('id'));
    if (!guard.lead) return fail(c, 'Seguimiento no encontrado', 404);
    if (guard.denied) return fail(c, 'Este seguimiento es de otro agente', 403);
    const body = await c.req.json().catch(() => ({} as any));
    const patch: any = { updated_at: new Date().toISOString() };
    for (const f of ['customer_id', 'customer_name', 'phone', 'email', 'zone', 'agent_id',
      'agent_name', 'source', 'interest', 'estimated_amount', 'next_follow_up', 'lost_reason']) {
      if (body?.[f] !== undefined) patch[f] = body[f] === '' ? null : body[f];
    }
    const { data, error } = await db.from('leads').update(patch)
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/interactions — registra un toque con el cliente y mueve el estado.
leads.post('/:id/interactions', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const parsed = InteractionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const guard = await loadOwned(c, id);
    if (!guard.lead) return fail(c, 'Seguimiento no encontrado', 404);
    if (guard.denied) return fail(c, 'Este seguimiento es de otro agente', 403);
    const lead = guard.lead;

    const at = parsed.data.happened_at || new Date().toISOString();
    const { data: inter, error } = await db.from('lead_interactions').insert({
      tenant_id: tenantId, lead_id: id,
      kind: parsed.data.kind || 'llamada',
      note: parsed.data.note ?? null,
      status_after: parsed.data.status ?? null,
      happened_at: at,
      next_follow_up: parsed.data.next_follow_up || null,
      created_by: userId,
    }).select('*').single();
    if (error) throw new Error(error.message);

    // El seguimiento refleja SIEMPRE el último toque: así la lista se ordena por
    // lo que de verdad pasó y no por cuándo alguien abrió la pantalla.
    const patch: any = { last_contact_at: at, updated_at: new Date().toISOString() };
    if (parsed.data.next_follow_up !== undefined) patch.next_follow_up = parsed.data.next_follow_up || null;
    if (parsed.data.status) {
      patch.status = parsed.data.status;
      if (parsed.data.status === 'ganado' || parsed.data.status === 'perdido') {
        patch.closed_at = new Date().toISOString();
      }
    } else if ((lead as any).status === 'nuevo') {
      // Ya se le habló: deja de ser "nuevo" aunque nadie lo mueva a mano.
      patch.status = 'contactado';
    }
    const { data: updated } = await db.from('leads').update(patch)
      .eq('id', id).eq('tenant_id', tenantId).select('*').single();

    return ok(c, { interaction: inter, lead: updated }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/close — ganado (con la venta/cotización que lo cerró) o perdido.
leads.post('/:id/close', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const guard = await loadOwned(c, id);
    if (!guard.lead) return fail(c, 'Seguimiento no encontrado', 404);
    if (guard.denied) return fail(c, 'Este seguimiento es de otro agente', 403);

    const body = await c.req.json().catch(() => ({} as any));
    const status = body?.status === 'perdido' ? 'perdido' : 'ganado';

    const patch: any = {
      status,
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      lost_reason: status === 'perdido' ? (body?.lost_reason ?? null) : null,
    };
    for (const f of ['invoice_id', 'proforma_id', 'agent_order_id']) {
      if (body?.[f]) patch[f] = body[f];
    }
    if (body?.estimated_amount != null) patch.estimated_amount = Number(body.estimated_amount) || 0;

    const { data, error } = await db.from('leads').update(patch)
      .eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);

    await db.from('lead_interactions').insert({
      tenant_id: tenantId, lead_id: id,
      kind: status === 'ganado' ? 'venta' : 'otro',
      note: status === 'ganado'
        ? (body?.note ?? 'Se concretó la venta')
        : `Perdido: ${body?.lost_reason ?? 'sin motivo'}`,
      status_after: status,
      created_by: userId,
    });

    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

leads.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    // Borrar elimina la historia completa del interesado. Un agente puede
    // marcarlo perdido, pero hacerlo desaparecer es decisión de la gerencia.
    const scope = await leadScope(c);
    if (!scope.manager) {
      return fail(c, 'Solo el administrador o el gerente pueden borrar un seguimiento. '
        + 'Si no se concretó, marcalo como perdido con su motivo.', 403);
    }
    const { error } = await db.from('leads').delete()
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default leads;
