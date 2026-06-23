import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const branches = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// Garantiza que el tenant SIEMPRE tenga al menos la sucursal Principal.
// Si no existe ninguna, la crea (marcada como default) y la devuelve.
// Garantiza que la sucursal tenga al menos una bodega central por defecto.
async function ensureCentralWarehouse(tenantId: string, branchId: string) {
  const { data: ws } = await db.from('warehouses')
    .select('id, is_default, type').eq('tenant_id', tenantId).eq('branch_id', branchId);
  if (ws && ws.length > 0) {
    if (!ws.some((w: any) => w.is_default)) {
      await db.from('warehouses').update({ is_default: true }).eq('id', (ws[0] as any).id);
    }
    return;
  }
  await db.from('warehouses').insert({
    tenant_id: tenantId, branch_id: branchId,
    name: 'Bodega central', code: 'CENTRAL', type: 'central', is_default: true,
  });
}

async function ensurePrincipalBranch(tenantId: string) {
  const { data: existing } = await db.from('branches')
    .select('*').eq('tenant_id', tenantId).order('name');
  if (existing && existing.length > 0) {
    // Si ninguna está marcada como default, marcamos la primera.
    if (!existing.some((b: any) => b.is_default)) {
      await db.from('branches').update({ is_default: true }).eq('id', (existing[0] as any).id);
      (existing[0] as any).is_default = true;
    }
    const def = existing.find((b: any) => b.is_default) ?? existing[0];
    await ensureCentralWarehouse(tenantId, (def as any).id).catch(() => {});
    return existing;
  }
  // Buscar el nombre del negocio para el nombre de la sucursal.
  let name = 'Principal';
  try {
    const { data: t } = await db.from('tenants').select('name').eq('id', tenantId).maybeSingle();
    if ((t as any)?.name) name = `${(t as any).name} (Principal)`;
  } catch { /* ignore */ }
  const { data: created } = await db.from('branches').insert({
    tenant_id: tenantId, name, code: 'PRINCIPAL', is_active: true, is_default: true,
  }).select().single();
  // Bodega central de arranque.
  if (created) await ensureCentralWarehouse(tenantId, (created as any).id).catch(() => {});
  return created ? [created] : [];
}

// GET / — lista de branches del tenant actual (siempre con la Principal)
branches.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return ok(c, []);
    const data = await ensurePrincipalBranch(tenantId);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /mine — branches accesibles para el user actual
branches.get('/mine', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return ok(c, []);
    await ensurePrincipalBranch(tenantId);
    const { data, error } = await db.from('branches')
      .select('*').eq('tenant_id', tenantId).eq('is_active', true).order('name');
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST / — crear branch
branches.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return fail(c, 'Tenant requerido', 400);
    const body = await c.req.json();
    const { data, error } = await db.from('branches').insert({
      tenant_id:            tenantId,
      name:                 body.name,
      code:                 body.code ?? null,
      address:              body.address ?? null,
      city:                 body.city ?? null,
      phone:                body.phone ?? null,
      hacienda_branch_code: body.hacienda_branch_code ?? null,
      is_active:            body.is_active ?? true,
      is_default:           body.is_default ?? false,
    }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /:id
branches.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const { data, error } = await db.from('branches')
      .update(body).eq('id', id).eq('tenant_id', tenantId)
      .select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// DELETE /:id
branches.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db.from('branches')
      .delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/set-default
branches.post('/:id/set-default', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    await db.from('branches').update({ is_default: false }).eq('tenant_id', tenantId);
    const { error } = await db.from('branches')
      .update({ is_default: true }).eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /:id/users — asignar usuarios
branches.put('/:id/users', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const userIds: string[] = body.user_ids ?? [];
    // tabla branch_users(branch_id, user_id) — si no existe, devuelve error claro
    await db.from('branch_users').delete().eq('branch_id', id);
    if (userIds.length > 0) {
      const rows = userIds.map(uid => ({ branch_id: id, user_id: uid }));
      const { error } = await db.from('branch_users').insert(rows);
      if (error) throw new Error(error.message);
    }
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default branches;
