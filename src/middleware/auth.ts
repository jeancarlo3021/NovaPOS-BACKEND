import { createMiddleware } from 'hono/factory';
import { db } from '../db/client.js';

type Variables = { userId: string; tenantId: string; role: string };

/**
 * Memoria corta de «qué usuario es este token».
 *
 * Vive en el proceso: en un servidor sin estado cada instancia tiene la suya y
 * se pierde al reciclarse. Aun así ayuda, porque las peticiones de una misma
 * pantalla caen casi siempre en la misma instancia y llegan en ráfaga.
 */
const USER_TTL_MS = 30_000;
const userCache = new Map<string, { at: number; row: { id: string; tenant_id: string | null; role: string | null } }>();

function readUserCache(userId: string) {
  const hit = userCache.get(userId);
  if (!hit || Date.now() - hit.at > USER_TTL_MS) return null;
  return hit.row;
}

function writeUserCache(userId: string, row: any) {
  // Tope de tamaño: sin él, un servidor de larga vida acumula usuarios sin fin.
  if (userCache.size > 500) userCache.clear();
  userCache.set(userId, { at: Date.now(), row });
}

/** Para invalidar a mano cuando se cambia el rol o el negocio de un usuario. */
export function forgetCachedUser(userId: string): void {
  userCache.delete(userId);
}

export const auth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
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

  /**
   * Quién es el usuario, con memoria corta.
   *
   * Esta consulta corre en TODA petición del sistema. Además de costar un viaje
   * a la base por request, es de las que más sufre cuando la base tiene una de
   * sus rachas malas: si falla, la petición muere aunque el trabajo real no
   * tuviera nada que ver con el usuario.
   *
   * Treinta segundos de memoria: un cambio de rol tarda a lo sumo eso en
   * aplicarse —imperceptible— y a cambio la mayoría de las peticiones seguidas
   * de un mismo cajero dejan de tocar la base.
   */
  const cacheHit = readUserCache(userId);
  let userData: { id: string; tenant_id: string | null; role: string | null } | null = null;
  let userDbError: any = null;

  if (cacheHit) {
    userData = cacheHit;
  } else {
    const r = await db
      .from('users')
      .select('id, tenant_id, role')
      .eq('id', userId)
      .maybeSingle();
    userData = (r.data as any) ?? null;
    userDbError = r.error;
    if (userData?.tenant_id) writeUserCache(userId, userData);
  }

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
    // ── Excepción: rutas que NO requieren tenant ─────────────────────────
    // El SaaS admin no tiene tenant operativo. Estas rutas son globales:
    //  - /admin/*         → gestión de tenants (super-admin)
    //  - /tenant-groups/* → grupos multi-empresa
    //  - /plans (GET)     → catálogo público de planes SaaS (excepto /plans/current)
    // El control fino lo hace cada handler con userId + body.
    const path   = c.req.path || '';
    const method = (c.req.method || 'GET').toUpperCase();

    // Usamos `includes` en lugar de `===` porque Hono puede reportar el path
    // con o sin prefix dependiendo del mount level (p. ej. "/api/plans" vs "/plans").
    const isAdminRoute = path.includes('/admin/')         || path.endsWith('/admin');
    const isGroupRoute = path.includes('/tenant-groups/') || path.endsWith('/tenant-groups');
    const isPlansRead  = method === 'GET'
                         && (path.includes('/plans/') || path.endsWith('/plans'))
                         && !path.endsWith('/plans/current')
                         && !path.includes('/plans/current?');

    if (isAdminRoute || isGroupRoute || isPlansRead) {
      console.log('[AUTH] Bypass tenant for global route:', path);
      c.set('userId', userId);
      c.set('tenantId', ''); // explícito: sin tenant
      c.set('role', 'admin');
      await next();
      return;
    }

    console.warn('[AUTH] Usuario sin tenant:', userId);
    return c.json({ data: null, error: 'Usuario sin tenant asignado' }, 403);
  }

  c.set('userId', userId);
  c.set('tenantId', tenantId);
  c.set('role', 'owner');
  await next();
});
