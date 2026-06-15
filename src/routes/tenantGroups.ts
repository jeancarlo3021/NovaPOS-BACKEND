import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * Endpoints para gestión de grupos de empresas (multi-empresa con sucursales
 * separadas, cada una con su propio plan SaaS y plan FE).
 *
 * Todas las rutas requieren auth. Las acciones de modificación verifican
 * que el usuario sea owner del grupo.
 */
const groups = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// ── Schemas ────────────────────────────────────────────────────────────────
const CreateGroupSchema = z.object({
  name:           z.string().min(2),
  billing_email:  z.string().email().optional().nullable(),
  notes:          z.string().optional().nullable(),
  main_tenant_id: z.string().uuid().optional().nullable(),
  // Si no se pasa, el dueño es el usuario que crea el grupo (el JWT actual).
  owner_id:       z.string().uuid().optional().nullable(),
});

const TransferOwnerSchema = z.object({
  new_owner_id: z.string().uuid(),
});

const AddBranchSchema = z.object({
  // Modo A: enlazar un tenant existente
  tenant_id:    z.string().uuid().optional(),
  // Modo B: crear un tenant nuevo desde cero
  new_tenant: z.object({
    name:           z.string().min(2),
    owner_email:    z.string().email().optional().nullable(),
    plan_id:        z.string().uuid().optional().nullable(),    // plan SaaS de módulos
    is_demo:        z.boolean().optional().default(false),
  }).optional(),
  // Plan FE opcional (si no se asigna, queda sin FE)
  fe_plan_id:   z.string().uuid().optional().nullable(),
});

const AssignFePlanSchema = z.object({
  fe_plan_id: z.string().uuid(),
});

// ── Helpers ────────────────────────────────────────────────────────────────
async function isGroupOwner(userId: string, groupId: string): Promise<boolean> {
  // Owner directo
  const { data } = await db.from('tenant_groups')
    .select('owner_id').eq('id', groupId).maybeSingle();
  if (data?.owner_id === userId) return true;

  // Super-admin: tiene admin_dashboard en su plan → puede tocar cualquier grupo
  try {
    const { data: u } = await db.from('users').select('tenant_id').eq('id', userId).maybeSingle();
    if (!u?.tenant_id) return false;
    const { data: t } = await db.from('tenants').select('plan_id').eq('id', u.tenant_id).maybeSingle();
    if (!t?.plan_id) return false;
    const { data: p } = await db.from('subscription_plans').select('features').eq('id', t.plan_id).maybeSingle();
    return (p?.features as any)?.admin_dashboard === true;
  } catch { return false; }
}

// ── GET / — listar grupos del usuario actual ───────────────────────────────
// Query param ?scope=all → super-admin ve TODOS los grupos del sistema.
// Para que sea seguro, validamos que el user tenga admin_dashboard en su plan.
groups.get('/', async (c) => {
  try {
    const userId = c.get('userId');
    const scope  = c.req.query('scope') ?? 'own';

    // Detectar si es super-admin (su plan tiene admin_dashboard=true).
    let isSuperAdmin = false;
    try {
      const { data: u } = await db.from('users')
        .select('tenant_id').eq('id', userId).maybeSingle();
      if (u?.tenant_id) {
        const { data: t } = await db.from('tenants')
          .select('plan_id').eq('id', u.tenant_id).maybeSingle();
        if (t?.plan_id) {
          const { data: p } = await db.from('subscription_plans')
            .select('features').eq('id', t.plan_id).maybeSingle();
          isSuperAdmin = (p?.features as any)?.admin_dashboard === true;
        }
      }
    } catch { /* ignore — sigue como no-admin */ }

    let query = db.from('tenant_groups').select('*').order('created_at', { ascending: false });

    if (scope === 'all' && isSuperAdmin) {
      // Super-admin ve TODOS los grupos, sin filtro.
    } else {
      // Default: solo los que el user posee.
      query = query.eq('owner_id', userId);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── GET /:id — detalle del grupo + sus sucursales + plan FE de cada una ───
groups.get('/:id', async (c) => {
  try {
    const userId = c.get('userId');
    const { id } = c.req.param();
    if (!(await isGroupOwner(userId, id))) {
      return fail(c, 'No autorizado', 403);
    }

    const { data: group } = await db.from('tenant_groups').select('*').eq('id', id).maybeSingle();
    if (!group) return fail(c, 'Grupo no encontrado', 404);

    // Datos del usuario principal (owner del grupo) — los traemos por separado
    // porque tenant_groups.owner_id apunta a auth.users sin FK declarada.
    let owner_info: { id: string; email: string | null; full_name: string | null } | null = null;
    try {
      const { data: uRow } = await db.from('users')
        .select('id, email, full_name').eq('id', group.owner_id).maybeSingle();
      if (uRow) owner_info = { id: uRow.id, email: uRow.email, full_name: uRow.full_name ?? null };
    } catch { /* ignore — public.users puede no existir o tener otra estructura */ }

    // Sucursales — solo tenants + subscription. NO embebemos tenant_fe_plans
    // porque no hay FK directa entre tenant_group_members y tenant_fe_plans
    // (ambos van a tenants, pero PostgREST no resuelve esa relación implícita).
    const { data: members, error: mErr } = await db.from('tenant_group_members')
      .select(`
        role, joined_at,
        tenant:tenants(
          id, name, is_demo, status, created_at,
          subscription:subscriptions!tenants_subscription_id_fkey(
            id, status, started_at, ends_at,
            plan:plan_id(id, name, price)
          )
        )
      `)
      .eq('group_id', id);
    if (mErr) throw new Error(mErr.message);

    // FE plans por separado y los inyectamos en cada member.
    const tenantIds = (members ?? []).map((m: any) => m.tenant?.id).filter(Boolean);
    let feByTenant: Record<string, any> = {};
    if (tenantIds.length > 0) {
      const { data: feRows, error: feErr } = await db.from('tenant_fe_plans')
        .select('tenant_id, fe_plan_id, current_usage, reset_at, active, fe_plan:fe_plans(id, code, name, monthly_quota, monthly_price)')
        .in('tenant_id', tenantIds);
      if (feErr) console.warn('[tenant-groups] fe lookup error:', feErr.message);
      feByTenant = Object.fromEntries((feRows ?? []).map((r: any) => [r.tenant_id, r]));
    }

    // Inyectar fe en cada member (el frontend espera m.fe directamente)
    const enriched = (members ?? []).map((m: any) => ({
      ...m,
      fe: m.tenant?.id ? feByTenant[m.tenant.id] ?? null : null,
    }));

    return ok(c, { group, owner_info, members: enriched, fe_by_tenant: feByTenant });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── GET /:id/billing — totales mensuales del grupo (RPC) ───────────────────
groups.get('/:id/billing', async (c) => {
  try {
    const userId = c.get('userId');
    const { id } = c.req.param();
    if (!(await isGroupOwner(userId, id))) return fail(c, 'No autorizado', 403);
    const { data, error } = await db.rpc('group_billing', { p_group_id: id });
    if (error) throw new Error(error.message);
    return ok(c, Array.isArray(data) ? data[0] : data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── GET /:id/sales — reporte consolidado de ventas ─────────────────────────
groups.get('/:id/sales', async (c) => {
  try {
    const userId = c.get('userId');
    const { id }  = c.req.param();
    const from = c.req.query('from');
    const to   = c.req.query('to');
    if (!from || !to) return fail(c, 'from y to son requeridos (ISO timestamps)', 422);
    if (!(await isGroupOwner(userId, id))) return fail(c, 'No autorizado', 403);

    const { data, error } = await db.rpc('group_sales_report', {
      p_group_id: id, p_from: from, p_to: to,
    });
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── POST / — crear grupo ───────────────────────────────────────────────────
groups.post('/', async (c) => {
  try {
    const userId = c.get('userId');
    const parsed = CreateGroupSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    // Si el creador pasa un owner_id distinto, se lo asignamos. Eso permite
    // al super-admin armar grupos "para otro" (ej. cliente Mas que cafe → su
    // owner real es yesgonzad@gmail.com aunque el grupo lo cree el admin).
    const finalOwnerId = parsed.data.owner_id ?? userId;

    const { data: group, error } = await db.from('tenant_groups')
      .insert({
        name:          parsed.data.name,
        owner_id:      finalOwnerId,
        billing_email: parsed.data.billing_email ?? null,
        notes:         parsed.data.notes ?? null,
      })
      .select().single();
    if (error) throw new Error(error.message);

    // Si nos pasan el tenant matriz, lo enlazamos como 'main'.
    if (parsed.data.main_tenant_id) {
      await db.from('tenant_group_members').insert({
        group_id:  group.id,
        tenant_id: parsed.data.main_tenant_id,
        role:      'main',
      });
      // Aseguramos user_tenants para que el dueño pueda saltar.
      await db.from('user_tenants').upsert({
        user_id: userId, tenant_id: parsed.data.main_tenant_id, role: 'owner', is_default: true,
      });
    }

    return ok(c, group, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── PATCH /:id — actualizar grupo (nombre, billing_email, notes) ──────────
groups.patch('/:id', async (c) => {
  try {
    const userId = c.get('userId');
    const { id } = c.req.param();
    if (!(await isGroupOwner(userId, id))) return fail(c, 'No autorizado', 403);

    const body = await c.req.json();
    const allowed: any = {};
    if (typeof body.name === 'string')          allowed.name          = body.name;
    if (typeof body.billing_email === 'string') allowed.billing_email = body.billing_email;
    if (typeof body.notes === 'string')         allowed.notes         = body.notes;

    const { data, error } = await db.from('tenant_groups')
      .update(allowed).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── PUT /:id/owner — transferir propiedad del grupo a otro usuario ────────
// Solo el owner actual puede transferir. El user nuevo automáticamente
// recibe acceso a todas las sucursales del grupo vía user_tenants.
groups.put('/:id/owner', async (c) => {
  try {
    const userId = c.get('userId');
    const { id } = c.req.param();
    if (!(await isGroupOwner(userId, id))) return fail(c, 'No autorizado', 403);

    const parsed = TransferOwnerSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const newOwnerId = parsed.data.new_owner_id;

    // Validar que el nuevo owner exista
    const { data: nu } = await db.from('users').select('id').eq('id', newOwnerId).maybeSingle();
    if (!nu) return fail(c, 'Usuario destino no encontrado', 404);

    // 1) Cambiar owner del grupo
    const { error: upErr } = await db.from('tenant_groups')
      .update({ owner_id: newOwnerId, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (upErr) throw new Error(upErr.message);

    // 2) Garantizar que el nuevo owner tenga acceso a TODAS las sucursales
    const { data: branches } = await db.from('tenant_group_members')
      .select('tenant_id, role').eq('group_id', id);
    if (Array.isArray(branches) && branches.length > 0) {
      const rows = branches.map(b => ({
        user_id:    newOwnerId,
        tenant_id:  b.tenant_id,
        role:       'owner',
        is_default: b.role === 'main',
      }));
      await db.from('user_tenants').upsert(rows, { onConflict: 'user_id,tenant_id' });
    }

    return ok(c, { transferred: true, new_owner_id: newOwnerId });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── DELETE /:id — borrar grupo (no borra los tenants) ─────────────────────
groups.delete('/:id', async (c) => {
  try {
    const userId = c.get('userId');
    const { id } = c.req.param();
    if (!(await isGroupOwner(userId, id))) return fail(c, 'No autorizado', 403);
    const { error } = await db.from('tenant_groups').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── POST /:id/branches — agregar sucursal al grupo ────────────────────────
// Modo A: enlaza un tenant existente.
// Modo B: crea un tenant nuevo y lo enlaza.
groups.post('/:id/branches', async (c) => {
  try {
    const userId = c.get('userId');
    const { id: groupId } = c.req.param();
    if (!(await isGroupOwner(userId, groupId))) return fail(c, 'No autorizado', 403);

    const parsed = AddBranchSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    let tenantId = parsed.data.tenant_id ?? null;

    // Modo B: crear tenant nuevo
    if (!tenantId && parsed.data.new_tenant) {
      const nt = parsed.data.new_tenant;
      // schema_name es NOT NULL en tenants. Generamos uno único por tenant
      // siguiendo el patrón del edge function admin-create-owner (`tenant_<uuid>`).
      const tenantUuid = (globalThis.crypto as any)?.randomUUID?.()
        ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
      const schemaName = `tenant_${String(tenantUuid).replace(/-/g, '_')}`;

      const { data: created, error: tErr } = await db.from('tenants')
        .insert({
          name:        nt.name,
          owner_id:    userId,
          is_demo:     nt.is_demo ?? false,
          plan_id:     nt.plan_id ?? null,
          status:      'active',
          schema_name: schemaName,
        })
        .select('id').single();
      if (tErr) throw new Error(tErr.message);
      tenantId = created.id;

      // Si tiene plan, crear suscripción asociada para que aparezca con su
      // fecha de vencimiento en /admin/owners.
      if (nt.plan_id) {
        try {
          const { data: planRow } = await db.from('subscription_plans')
            .select('billing_cycle').eq('id', nt.plan_id).maybeSingle();
          const cycleDays = (planRow?.billing_cycle ?? 'monthly').toLowerCase() === 'yearly' ? 365 : 30;
          const endsAt = new Date(Date.now() + cycleDays * 86400000).toISOString();

          const { data: subData } = await db.from('subscriptions')
            .insert({
              tenant_id: tenantId,
              plan_id:   nt.plan_id,
              status:    'active',
              ends_at:   endsAt,
              auto_renew: true,
            })
            .select('id').single();
          if (subData?.id) {
            await db.from('tenants').update({ subscription_id: subData.id }).eq('id', tenantId);
          }
        } catch (e: any) {
          console.warn('[branches] no se pudo crear suscripción:', e?.message);
        }
      }
    }

    if (!tenantId) {
      return fail(c, 'Debés pasar tenant_id (modo enlazar) o new_tenant (modo crear)', 422);
    }

    // Enlazar al grupo
    const { error: linkErr } = await db.from('tenant_group_members').insert({
      group_id: groupId, tenant_id: tenantId, role: 'branch',
    });
    if (linkErr) throw new Error(linkErr.message);

    // Dar acceso al user que ejecuta la acción (super-admin o quien sea) Y al
    // dueño del grupo. Si los 2 son la misma persona, el upsert deduplica.
    const { data: ownerRow } = await db.from('tenant_groups')
      .select('owner_id').eq('id', groupId).maybeSingle();
    const accessUsers = new Set<string>([userId]);
    if (ownerRow?.owner_id) accessUsers.add(ownerRow.owner_id);

    const accessRows = Array.from(accessUsers).map(uid => ({
      user_id:    uid,
      tenant_id:  tenantId!,
      role:       'owner',
      is_default: false,
    }));
    await db.from('user_tenants').upsert(accessRows, { onConflict: 'user_id,tenant_id' });

    // Asignar plan FE opcional
    if (parsed.data.fe_plan_id) {
      await db.from('tenant_fe_plans').upsert({
        tenant_id: tenantId, fe_plan_id: parsed.data.fe_plan_id, active: true,
      });
    }

    return ok(c, { tenant_id: tenantId, linked: true }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── DELETE /:id/branches/:tenantId — desvincular sucursal ─────────────────
groups.delete('/:id/branches/:tenantId', async (c) => {
  try {
    const userId = c.get('userId');
    const { id: groupId, tenantId } = c.req.param();
    if (!(await isGroupOwner(userId, groupId))) return fail(c, 'No autorizado', 403);

    const { error } = await db.from('tenant_group_members')
      .delete().eq('group_id', groupId).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { unlinked: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── PUT /:id/branches/:tenantId/fe-plan — cambiar plan FE de una sucursal ─
groups.put('/:id/branches/:tenantId/fe-plan', async (c) => {
  try {
    const userId = c.get('userId');
    const { id: groupId, tenantId } = c.req.param();
    if (!(await isGroupOwner(userId, groupId))) return fail(c, 'No autorizado', 403);

    const parsed = AssignFePlanSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db.from('tenant_fe_plans')
      .upsert({
        tenant_id: tenantId,
        fe_plan_id: parsed.data.fe_plan_id,
        active: true,
        current_usage: 0,
        reset_at: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString(),
      })
      .select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── GET /fe-plans — catálogo de planes FE disponibles ─────────────────────
groups.get('/fe-plans/catalog', async (c) => {
  try {
    const { data, error } = await db.from('fe_plans')
      .select('*').eq('active', true).order('monthly_price');
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── GET /my-tenants — todos los tenants accesibles para el user ───────────
// El frontend usa esto para el TenantSwitcher rich (B). Reemplaza el filtro
// por owner_id por una consulta a user_tenants (multi-empresa real).
groups.get('/my/tenants', async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) return ok(c, []);

    // Consulta directa — el RPC `my_tenants()` filtra por auth.uid() que en
    // contexto server (service_role) es NULL y devuelve vacío. Hacemos el
    // mismo join acá pasando el userId del JWT decodificado por el middleware.
    const { data, error } = await db
      .from('user_tenants')
      .select(`
        tenant_id, role, is_default, joined_at,
        tenant:tenants!user_tenants_tenant_id_fkey(id, name, is_demo, status)
      `)
      .eq('user_id', userId)
      .order('is_default', { ascending: false });

    if (error) throw new Error(error.message);

    // Hidratar group_id / group_name vía tenant_group_members
    const tenantIds = (data ?? []).map((r: any) => r.tenant_id);
    let groupMap = new Map<string, { group_id: string; group_name: string }>();
    if (tenantIds.length > 0) {
      const { data: groups } = await db
        .from('tenant_group_members')
        .select('tenant_id, group:tenant_groups!tenant_group_members_group_id_fkey(id, name)')
        .in('tenant_id', tenantIds);
      for (const g of (groups ?? []) as any[]) {
        if (g.group) groupMap.set(g.tenant_id, { group_id: g.group.id, group_name: g.group.name });
      }
    }

    const result = (data ?? []).map((r: any) => ({
      tenant_id:   r.tenant_id,
      tenant_name: r.tenant?.name ?? '',
      is_demo:     r.tenant?.is_demo ?? false,
      status:      r.tenant?.status ?? 'active',
      role:        r.role,
      is_default:  r.is_default,
      joined_at:   r.joined_at,
      group_id:    groupMap.get(r.tenant_id)?.group_id ?? null,
      group_name:  groupMap.get(r.tenant_id)?.group_name ?? null,
    }));

    return ok(c, result);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── GET /my/branches-stats — métricas por sucursal del grupo del owner ────
// Devuelve, para cada tenant donde el caller es 'owner' en user_tenants:
//   { tenant_id, tenant_name, users_count, invoices_month, warehouses_count }
// Sirve para el panel "Mis sucursales" del dashboard de un owner de grupo.
groups.get('/my/branches-stats', async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) return ok(c, []);

    // 1. Tenants donde el user es owner
    const { data: ownedRows } = await db.from('user_tenants')
      .select('tenant_id').eq('user_id', userId).eq('role', 'owner');
    const tenantIds = (ownedRows ?? []).map((r: any) => r.tenant_id);
    if (tenantIds.length === 0) return ok(c, []);

    // 2. Nombres
    const { data: tenants } = await db.from('tenants')
      .select('id, name, is_demo, status').in('id', tenantIds);

    // 3. Conteo de users por tenant
    const { data: users } = await db.from('users')
      .select('tenant_id').in('tenant_id', tenantIds);
    const usersCount = new Map<string, number>();
    for (const u of (users ?? []) as any[]) {
      usersCount.set(u.tenant_id, (usersCount.get(u.tenant_id) ?? 0) + 1);
    }

    // 4. Facturas del mes en curso por tenant
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const { data: invoices } = await db.from('invoices')
      .select('tenant_id, total, created_at')
      .in('tenant_id', tenantIds)
      .gte('created_at', monthStart);
    const invoicesMonth = new Map<string, { count: number; total: number }>();
    for (const inv of (invoices ?? []) as any[]) {
      const cur = invoicesMonth.get(inv.tenant_id) ?? { count: 0, total: 0 };
      cur.count += 1;
      cur.total += Number(inv.total ?? 0);
      invoicesMonth.set(inv.tenant_id, cur);
    }

    // 5. Bodegas por tenant
    const { data: warehouses } = await db.from('warehouses')
      .select('tenant_id').in('tenant_id', tenantIds);
    const whCount = new Map<string, number>();
    for (const w of (warehouses ?? []) as any[]) {
      whCount.set(w.tenant_id, (whCount.get(w.tenant_id) ?? 0) + 1);
    }

    const result = (tenants ?? []).map((t: any) => ({
      tenant_id:        t.id,
      tenant_name:      t.name,
      is_demo:          t.is_demo,
      status:           t.status,
      users_count:      usersCount.get(t.id) ?? 0,
      invoices_month:   invoicesMonth.get(t.id)?.count ?? 0,
      invoices_total:   invoicesMonth.get(t.id)?.total ?? 0,
      warehouses_count: whCount.get(t.id) ?? 0,
    }));

    return ok(c, result);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── GET /my/branches-report?from=&to= — reporte consolidado de TODAS las
//    sucursales del owner en un rango. Devuelve por sucursal: ventas, IVA,
//    facturas, ticket promedio, gastos y ganancia bruta; más un total grupo.
groups.get('/my/branches-report', async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) return ok(c, { rows: [], totals: null });

    const from = c.req.query('from');
    const to   = c.req.query('to');

    // Tenants donde el user es owner
    const { data: ownedRows } = await db.from('user_tenants')
      .select('tenant_id').eq('user_id', userId).eq('role', 'owner');
    const tenantIds = (ownedRows ?? []).map((r: any) => r.tenant_id);
    if (tenantIds.length === 0) return ok(c, { rows: [], totals: null });

    const { data: tenants } = await db.from('tenants')
      .select('id, name, is_demo, status').in('id', tenantIds);

    // Facturas en rango (solo completadas) por tenant
    let invQ = db.from('invoices')
      .select('tenant_id, total, tax_amount, status, created_at')
      .in('tenant_id', tenantIds);
    if (from) invQ = invQ.gte('created_at', from);
    if (to)   invQ = invQ.lte('created_at', to);
    const { data: invoices } = await invQ;

    const salesByTenant = new Map<string, { count: number; total: number; tax: number }>();
    for (const inv of (invoices ?? []) as any[]) {
      if (inv.status === 'cancelled') continue;  // anuladas no cuentan
      const cur = salesByTenant.get(inv.tenant_id) ?? { count: 0, total: 0, tax: 0 };
      cur.count += 1;
      cur.total += Number(inv.total ?? 0);
      cur.tax   += Number(inv.tax_amount ?? 0);
      salesByTenant.set(inv.tenant_id, cur);
    }

    // Gastos en rango por tenant (si la tabla existe)
    const expByTenant = new Map<string, number>();
    try {
      let expQ = db.from('expenses').select('tenant_id, amount, expense_date, created_at').in('tenant_id', tenantIds);
      const { data: expenses } = await expQ;
      for (const e of (expenses ?? []) as any[]) {
        const d = e.expense_date ?? e.created_at;
        if (from && d && d < from) continue;
        if (to && d && d > to) continue;
        expByTenant.set(e.tenant_id, (expByTenant.get(e.tenant_id) ?? 0) + Number(e.amount ?? 0));
      }
    } catch { /* sin tabla de gastos */ }

    const rows = (tenants ?? []).map((t: any) => {
      const s = salesByTenant.get(t.id) ?? { count: 0, total: 0, tax: 0 };
      const expenses = expByTenant.get(t.id) ?? 0;
      const net = s.total - s.tax;             // ventas sin impuesto
      return {
        tenant_id:    t.id,
        tenant_name:  t.name,
        is_demo:      t.is_demo,
        status:       t.status,
        invoices:     s.count,
        sales_total:  s.total,
        tax_total:    s.tax,
        avg_ticket:   s.count > 0 ? Math.round(s.total / s.count) : 0,
        expenses,
        gross_profit: net - expenses,          // aprox: ventas netas - gastos
      };
    });

    // Totales del grupo
    const totals = rows.reduce((acc, r) => ({
      invoices:     acc.invoices + r.invoices,
      sales_total:  acc.sales_total + r.sales_total,
      tax_total:    acc.tax_total + r.tax_total,
      expenses:     acc.expenses + r.expenses,
      gross_profit: acc.gross_profit + r.gross_profit,
    }), { invoices: 0, sales_total: 0, tax_total: 0, expenses: 0, gross_profit: 0 });

    return ok(c, { rows, totals });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── POST /my/central-warehouse — crear bodega central para cada sucursal ──
// Si la sucursal ya tiene una bodega marcada como "central"/"default", se
// omite. Idempotente — podés llamarlo varias veces sin duplicar.
groups.post('/my/central-warehouse', async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) return fail(c, 'No autorizado', 401);

    const body = await c.req.json().catch(() => ({}));
    // Si vino un tenant_id específico, solo crea para esa sucursal. Si no,
    // crea para TODAS las sucursales donde el caller es owner.
    let targetTenants: string[] = [];
    if (body?.tenant_id) {
      // Verificar que sea owner de ese tenant
      const { data: own } = await db.from('user_tenants')
        .select('user_id').eq('user_id', userId)
        .eq('tenant_id', body.tenant_id).eq('role', 'owner').maybeSingle();
      if (!own) return fail(c, 'No sos owner de esa sucursal', 403);
      targetTenants = [body.tenant_id];
    } else {
      const { data: rows } = await db.from('user_tenants')
        .select('tenant_id').eq('user_id', userId).eq('role', 'owner');
      targetTenants = (rows ?? []).map((r: any) => r.tenant_id);
    }

    let created = 0;
    for (const tid of targetTenants) {
      // Buscar branch por defecto del tenant (donde colgar la bodega).
      const { data: branch } = await db.from('branches')
        .select('id').eq('tenant_id', tid).eq('is_default', true).maybeSingle();
      const branchId = branch?.id;
      if (!branchId) {
        // Si no hay branches, lo skipeamos — la sucursal no tiene branch
        // operativa todavía. Loggeamos para debug.
        console.warn('[central-warehouse] tenant sin branch default:', tid);
        continue;
      }
      // ¿Ya existe bodega central?
      const { data: existing } = await db.from('warehouses')
        .select('id').eq('tenant_id', tid).eq('is_default', true).maybeSingle();
      if (existing) continue;

      const { error } = await db.from('warehouses').insert({
        tenant_id:  tid,
        branch_id:  branchId,
        name:       'Bodega Central',
        code:       'CENTRAL',
        is_active:  true,
        is_default: true,
      });
      if (error) {
        console.warn('[central-warehouse] insert fallo para', tid, error.message);
        continue;
      }
      created++;
    }

    return ok(c, { created, total_tenants: targetTenants.length });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default groups;
