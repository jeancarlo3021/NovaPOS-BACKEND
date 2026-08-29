import { createMiddleware } from 'hono/factory';
import { db } from '../db/client.js';
import { maybeResetDemo } from '../services/demoReset.js';

type Variables = { userId: string; tenantId: string; role: string };

/** Memoria corta del estado del negocio (ver el porqué más abajo). */
const TENANT_TTL_MS = 20_000;
const tenantCache = new Map<string, { at: number; row: any }>();

/** Se olvida al cambiar el estado del negocio, para que aplique al instante. */
export function forgetCachedTenant(tenantId: string): void {
  tenantCache.delete(tenantId);
}

// Estados del tenant que cortan acceso al API.
const BLOCKED = new Set(['suspended', 'inactive', 'cancelled']);

// Días de gracia tras el vencimiento antes de pasar a SOLO LECTURA.
const GRACE_DAYS = 6;

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

  /**
   * Estado del negocio, con memoria corta.
   *
   * Corre en toda petición y consulta `tenants`, otra de las tablas que se caen
   * durante las rachas malas de la base. Veinte segundos de memoria: suspender
   * una cuenta sigue surtiendo efecto casi al instante, y el sistema deja de
   * preguntar lo mismo decenas de veces por minuto.
   */
  const hit = tenantCache.get(tenantId);
  let data: any = null;
  let error: any = null;
  if (hit && Date.now() - hit.at < TENANT_TTL_MS) {
    data = hit.row;
  } else {
    const r = await db
      .from('tenants')
      .select('status, is_demo, demo_reset_at')
      .eq('id', tenantId)
      .maybeSingle();
    data = r.data; error = r.error;
    if (!error && data) {
      if (tenantCache.size > 500) tenantCache.clear();
      tenantCache.set(tenantId, { at: Date.now(), row: data });
    }
  }

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

  // ── DEMO ETERNO ───────────────────────────────────────────────────────────
  // La cuenta demo nunca vence; en cambio, sus datos (productos y movimientos)
  // se limpian cada 8 días. El reseteo se dispara perezosamente al acceder.
  if ((data as any)?.is_demo) {
    try { await maybeResetDemo(tenantId, (data as any).demo_reset_at ?? null); }
    catch (e: any) { console.warn('[demo-reset] middleware:', e?.message); }
    return next();
  }

  // ── Expiración con gracia → SOLO LECTURA ──────────────────────────────────
  // Si la suscripción venció hace más de GRACE_DAYS, se bloquean las
  // MUTACIONES (POST/PUT/PATCH/DELETE) pero se permite seguir viendo (GET).
  // Las de plan Admin / sin fecha de fin nunca vencen.
  const method = c.req.method;
  if (method !== 'GET' && method !== 'OPTIONS' && method !== 'HEAD') {
    const { data: sub } = await db
      .from('subscriptions')
      .select('ends_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const endsAt = (sub as any)?.ends_at;
    if (endsAt) {
      const graceMs = GRACE_DAYS * 24 * 60 * 60 * 1000;
      if (new Date(endsAt).getTime() + graceMs < Date.now()) {
        return c.json({
          data: null,
          error: 'Suscripción vencida — modo solo lectura. Regularizá el pago para hacer cambios.',
          code: 'tenant_expired',
        }, 403);
      }
    }
  }

  await next();
});
