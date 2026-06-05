import { createMiddleware } from 'hono/factory';
import { db } from '../db/client.js';

type Variables = { userId: string; tenantId: string; role: string; branchId?: string };

export const auth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  // Sucursal activa enviada por el cliente; nullable mientras se va integrando.
  const branchHeader = c.req.header('x-branch-id');
  if (branchHeader) c.set('branchId', branchHeader);
  if (!token) {
    console.warn('[AUTH] Token no proporcionado para:', c.req.path);
    return c.json({ data: null, error: 'No autorizado: token no proporcionado' }, 401);
  }

  let userId: string | null = null;
  let error: any = null;

  try {
    console.log('[AUTH] Validating token for path:', c.req.path);

    // Decode the JWT - split into parts
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }

    // Decode payload (second part)
    let payload: any;
    try {
      const decoded = Buffer.from(parts[1], 'base64').toString('utf-8');
      payload = JSON.parse(decoded);
      console.log('[AUTH] Token payload keys:', Object.keys(payload).join(', '));
    } catch (parseErr: any) {
      console.error('[AUTH] Failed to parse token payload:', parseErr.message);
      throw new Error('Failed to parse token');
    }

    // Extract user ID (Supabase uses 'sub' for user ID)
    userId = payload.sub;

    if (!userId) {
      console.warn('[AUTH] Token missing sub claim. Keys:', Object.keys(payload).join(', '));
      throw new Error('No user ID in token');
    }

    // Check expiration if present
    if (payload.exp) {
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) {
        throw new Error('Token expired');
      }
    }

    console.log('[AUTH] ✅ Valid token for user:', userId);
  } catch (err) {
    console.error('[AUTH] ❌ Token validation failed:', (err instanceof Error) ? err.message : String(err));
    error = err;
  }

  if (error || !userId) {
    console.warn('[AUTH] Token rechazado para:', c.req.path, 'Error:', error?.message || 'No user ID');
    return c.json({
      data: null,
      error: 'Token inválido o expirado. Por favor, vuelve a iniciar sesión.',
      details: process.env.NODE_ENV === 'development' ? error?.message : undefined
    }, 401);
  }

  // First try: Check users table
  const { data: userData, error: userDbError } = await db
    .from('users')
    .select('id, tenant_id, role')
    .eq('id', userId)
    .maybeSingle();

  if (userDbError) {
    console.warn('[AUTH] Error en query users:', userDbError.message);
  }

  // If found in users table, use that
  if (userData?.tenant_id) {
    c.set('userId', userId);
    c.set('tenantId', userData.tenant_id);
    c.set('role', userData.role ?? 'staff');
    await next();
    return;
  }

  // Fallback: Try as tenant owner (fast query - indexed on owner_id)
  const { data: tenantData, error: tenantError } = await db
    .from('tenants')
    .select('id')
    .eq('owner_id', userId)
    .limit(1)
    .maybeSingle();

  if (tenantError) {
    console.warn('[AUTH] Error buscando tenant:', tenantError.message);
  }

  const tenantId = tenantData?.id;
  if (!tenantId) {
    console.warn('[AUTH] Usuario sin tenant:', userId);
    return c.json({ data: null, error: 'Usuario sin tenant asignado' }, 403);
  }

  c.set('userId', userId);
  c.set('tenantId', tenantId);
  c.set('role', 'owner');
  await next();
});
