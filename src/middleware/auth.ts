import { createMiddleware } from 'hono/factory';
import { db, anonClient } from '../db/client.js';

type Variables = { userId: string; tenantId: string; role: string };

export const auth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return c.json({ data: null, error: 'No autorizado' }, 401);

  const {
    data: { user },
    error,
  } = await anonClient.auth.getUser(token);
  if (error || !user) return c.json({ data: null, error: 'Token inválido' }, 401);

  const { data: userData } = await db
    .from('users')
    .select('id, tenant_id, role')
    .eq('id', user.id)
    .maybeSingle();

  if (!userData?.tenant_id) return c.json({ data: null, error: 'Sin tenant' }, 403);

  c.set('userId', user.id);
  c.set('tenantId', userData.tenant_id);
  c.set('role', userData.role ?? 'staff');
  await next();
});
