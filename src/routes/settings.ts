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

// PUT /:type — upsert settings
settings.put('/:type', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { type } = c.req.param();
    const config = await c.req.json();

    const { data, error } = await db.from('settings').upsert({
      tenant_id: tenantId, type, config,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' }).select().single();

    if (error) throw new Error(error.message);
    return ok(c, data?.config ?? config);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default settings;
