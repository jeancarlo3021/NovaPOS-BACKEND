import type { Context, Next } from 'hono';
import { db } from '../db/client.js';
import { fail } from '../utils/response.js';

/**
 * Permisos por rol, aplicados EN EL SERVIDOR.
 *
 * Hasta ahora los permisos solo escondían botones en la pantalla. Eso no es una
 * restricción: cualquiera con la sesión abierta podía llamar la API igual —de
 * hecho así fue como un empleado terminó modificando el inventario que no le
 * correspondía—. Esconder el botón evita el error honesto; esto evita el resto.
 *
 * La matriz vive en `role_permissions` (tenant_id, role, module, can_*).
 */

type Action = 'create' | 'edit' | 'delete';

/** Cache corto: la matriz cambia poco y esto corre en cada escritura. */
const cache = new Map<string, { at: number; row: any | null }>();
const TTL_MS = 60_000;

async function permissionRow(tenantId: string, role: string, module: string) {
  const key = `${tenantId}::${role}::${module}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row;

  const { data } = await db.from('role_permissions')
    .select('can_access, can_create, can_edit, can_delete')
    .eq('tenant_id', tenantId).eq('role', role).eq('module', module)
    .maybeSingle();

  cache.set(key, { at: Date.now(), row: data ?? null });
  return data ?? null;
}

/** ¿Este rol tiene configurada alguna matriz? (para no romper instalaciones nuevas) */
async function hasMatrix(tenantId: string, role: string): Promise<boolean> {
  const key = `${tenantId}::${role}::__any__`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return !!hit.row;

  const { data } = await db.from('role_permissions')
    .select('module').eq('tenant_id', tenantId).eq('role', role).limit(1);
  const any = (data ?? []).length > 0;
  cache.set(key, { at: Date.now(), row: any ? { any: true } : null });
  return any;
}

/**
 * Middleware: exige permiso de escritura sobre un módulo.
 *
 * Reglas, en orden:
 *  · owner / admin  → siempre pueden.
 *  · sin matriz     → se permite. El negocio todavía no configuró permisos y
 *                     bloquear todo de golpe dejaría a los empleados sin trabajar.
 *  · con matriz y SIN fila para el módulo → se NIEGA. Si el dueño se tomó el
 *                     trabajo de configurar permisos, lo que no concedió no está
 *                     concedido. Esta es justo la puerta que estaba abierta.
 *  · con fila       → manda la fila.
 */
export function requirePermission(module: string, action: Action) {
  return async (c: Context, next: Next) => {
    const role = String(c.get('role') ?? '');
    if (role === 'owner' || role === 'admin') return next();

    const tenantId = String(c.get('tenantId') ?? '');
    if (!tenantId) return fail(c, 'Sin empresa activa', 403);

    try {
      if (!(await hasMatrix(tenantId, role))) return next();

      const row = await permissionRow(tenantId, role, module);
      if (!row || row.can_access !== true || row[`can_${action}`] !== true) {
        return fail(c, 'Tu rol no tiene permiso para esta acción.', 403);
      }
    } catch (e: any) {
      // Si la consulta falla, no se deja pasar a ciegas una escritura.
      console.warn('[permissions] no se pudo verificar:', e?.message);
      return fail(c, 'No se pudo verificar tus permisos. Intentá de nuevo.', 403);
    }
    return next();
  };
}

/** Limpia el cache (al guardar la matriz desde Usuarios → Roles). */
export function clearPermissionCache(): void {
  cache.clear();
}
