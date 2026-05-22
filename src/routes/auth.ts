import { Hono } from 'hono';
import { anonClient, db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const auth = new Hono();

/**
 * GET /auth/refresh — Refresh authentication session
 * Client should call this periodically or when getting token errors
 */
auth.post('/refresh', async (c) => {
  try {
    const body = await c.req.json() as { refresh_token?: string };
    const refreshToken = body.refresh_token;

    if (!refreshToken) {
      return fail(c, 'Token de refresco requerido', 400);
    }

    const { data, error } = await anonClient.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.session?.access_token) {
      console.error('[AUTH-REFRESH] Error refrescando sesión:', error);
      return fail(c, 'No se pudo refrescar la sesión. Por favor, inicia sesión nuevamente.', 401);
    }

    return ok(c, {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
    });
  } catch (err: any) {
    console.error('[AUTH-REFRESH] Error:', err.message);
    return fail(c, err.message, 500);
  }
});

/**
 * GET /auth/verify — Verify if current token is valid (debug endpoint)
 * Requires Authorization header
 */
auth.get('/verify', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return fail(c, 'Token no proporcionado', 401);
  }

  try {
    // Decode and show token structure
    const parts = token.split('.');
    if (parts.length !== 3) {
      return fail(c, 'Invalid token format - must have 3 parts', 400);
    }

    let payload: any;
    try {
      const decoded = Buffer.from(parts[1], 'base64').toString('utf-8');
      payload = JSON.parse(decoded);
    } catch (err) {
      return fail(c, 'Failed to parse token payload', 400);
    }

    // Check if user_id is present
    const userId = payload.sub;
    if (!userId) {
      return fail(c, `Token missing sub claim. Keys: ${Object.keys(payload).join(', ')}`, 400);
    }

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    const expired = payload.exp && payload.exp < now;

    return ok(c, {
      valid: !expired,
      user_id: userId,
      exp: payload.exp,
      exp_in_seconds: payload.exp ? payload.exp - now : 'unknown',
      expired,
      payload_keys: Object.keys(payload),
    });
  } catch (err) {
    console.error('[AUTH-VERIFY] Error:', err);
    return fail(c, 'Error verificando token', 500);
  }
});

/**
 * GET /auth/debug — Show detailed token information
 * No authentication required - helps diagnose auth issues
 */
auth.get('/debug', async (c) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '');

  if (!token) {
    return ok(c, {
      has_token: false,
      message: 'No Authorization header found',
      expected_header: 'Authorization: Bearer <token>',
    });
  }

  try {
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    const now = Math.floor(Date.now() / 1000);

    return ok(c, {
      has_token: true,
      token_format_valid: parts.length === 3,
      payload: payload,
      token_checks: {
        has_sub: !!payload.sub,
        has_exp: !!payload.exp,
        is_expired: payload.exp ? payload.exp < now : null,
        seconds_until_expiry: payload.exp ? payload.exp - now : null,
      },
      extracted_user_id: payload.sub || 'MISSING',
    });
  } catch (err) {
    return ok(c, {
      has_token: true,
      token_format_valid: false,
      error: (err instanceof Error) ? err.message : String(err),
      token_length: token.length,
      first_50_chars: token.substring(0, 50),
    });
  }
});

/**
 * POST /auth/fix-tenant — Fix missing tenant_id for current user
 * Finds the user's tenant from the database and updates their user record
 */
auth.post('/fix-tenant', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return fail(c, 'Token no proporcionado', 401);
  }

  try {
    // Decode token to get user ID
    const parts = token.split('.');
    if (parts.length !== 3) {
      return fail(c, 'Invalid token format', 400);
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    const userId = payload.sub;

    if (!userId) {
      return fail(c, 'No user ID in token', 400);
    }

    console.log('[AUTH-FIX] Fixing tenant for user:', userId);

    // Find tenant where user is owner
    const { data: tenants, error: tenantsError } = await db
      .from('tenants')
      .select('id')
      .eq('owner_id', userId)
      .limit(1);

    if (tenantsError) {
      console.error('[AUTH-FIX] Error finding tenant:', tenantsError);
      return fail(c, 'Error encontrando tenant', 500);
    }

    if (!tenants || tenants.length === 0) {
      return fail(c, 'Usuario no tiene ningún tenant asignado', 404);
    }

    const tenantId = tenants[0].id;

    // Update user record with tenant_id
    const { error: updateError } = await db
      .from('users')
      .update({ tenant_id: tenantId })
      .eq('id', userId);

    if (updateError) {
      console.error('[AUTH-FIX] Error updating user:', updateError);
      return fail(c, 'Error actualizando usuario', 500);
    }

    console.log('[AUTH-FIX] ✅ Fixed tenant for user:', userId, 'tenant:', tenantId);

    return ok(c, {
      success: true,
      user_id: userId,
      tenant_id: tenantId,
      message: 'Usuario actualizado correctamente',
    });
  } catch (err) {
    console.error('[AUTH-FIX] Error:', err);
    return fail(c, 'Error al corregir tenant', 500);
  }
});

export default auth;
