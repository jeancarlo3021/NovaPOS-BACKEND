import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const settings = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// GET /:type — get settings for tenant by type
settings.get('/:type', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { type } = c.req.param();
    const { data, error } = await db.from('settings').select('*')
      .eq('tenant_id', tenantId).eq('type', type).maybeSingle();
    if (error) throw new Error(error.message);
    return ok(c, data?.config ?? {});
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** ¿El usuario es super-admin? (su plan tiene admin_dashboard=true). */
async function isSuperAdmin(userId: string): Promise<boolean> {
  try {
    const { data: u } = await db.from('users').select('tenant_id').eq('id', userId).maybeSingle();
    if (!u?.tenant_id) return false;
    const { data: t } = await db.from('tenants').select('plan_id').eq('id', u.tenant_id).maybeSingle();
    if (!t?.plan_id) return false;
    const { data: p } = await db.from('subscription_plans').select('features').eq('id', t.plan_id).maybeSingle();
    return (p?.features as any)?.admin_dashboard === true;
  } catch { return false; }
}

// PUT /:type — upsert settings
settings.put('/:type', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { type } = c.req.param();
    const config = await c.req.json();

    // El AMBIENTE de facturación electrónica solo lo cambia el super-admin.
    // Si no lo es, se conserva el ambiente ya guardado (no se puede pasar a producción).
    if (type === 'electronic-invoice') {
      if (!(await isSuperAdmin(c.get('userId')))) {
        const { data: prev } = await db.from('settings').select('config')
          .eq('tenant_id', tenantId).eq('type', type).maybeSingle();
        const prevEnv = (prev?.config as any)?.environment ?? 'sandbox';
        config.environment = prevEnv;
      }
    }

    const { data, error } = await db.from('settings').upsert({
      tenant_id: tenantId, type, config,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' }).select().single();

    if (error) throw new Error(error.message);
    return ok(c, data?.config ?? config);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default settings;
