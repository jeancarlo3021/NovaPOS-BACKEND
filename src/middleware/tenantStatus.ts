import { createMiddleware } from 'hono/factory';
import { db } from '../db/client.js';

type Variables = { userId: string; tenantId: string; role: string };

// Estados del tenant que cortan acceso al API.
const BLOCKED = new Set(['suspended', 'inactive', 'cancelled']);

// Rutas que SIEMPRE deben pasar (panel admin, info propia del tenant para que
// el frontend pueda renderizar el modal con datos coherentes).
const BYPASS_PATTERNS = [
  /\/admin(\/|$)/,
  /\/tenants\/me$/,
];

/**
 * Bloquea cualquier acción del API si el tenant del usuario no está activo.
 * Debe montarse después de `auth` para que `tenantId` esté en el contexto.
 */
export const enforceActiveTenant = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const path = c.req.path;
  if (BYPASS_PATTERNS.some(rx => rx.test(path))) {
    return next();
  }

  const tenantId = c.get('tenantId');
  if (!tenantId) return next();

  const { data, error } = await db
    .from('tenants')
    .select('status')
    .eq('id', tenantId)
    .maybeSingle();

  if (error) {
    // No queremos romper la app por una query fallida; dejamos pasar
    // y que el siguiente handler maneje sus propios errores.
    console.warn('[TENANT_STATUS] lookup failed:', error.message);
    return next();
  }

  const status = data?.status;
  if (status && BLOCKED.has(status)) {
    return c.json({
      data: null,
      error: 'Cuenta del negocio inactiva — contacta al administrador',
      code: 'tenant_suspended',
      status,
    }, 403);
  }

  await next();
});
