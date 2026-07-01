import { db } from '../db/client.js';

// Roles que NO se restringen por zona (ven todo): dueños/gerencia.
const UNRESTRICTED = new Set(['owner', 'admin', 'gerente']);

/**
 * Devuelve la zona asignada al usuario si su rol está restringido por zona.
 * Los roles de gerencia (owner/admin/gerente) ven todo → devuelve null.
 */
export async function getUserZone(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const { data } = await db.from('users').select('zone, role').eq('id', userId).maybeSingle();
  const zone = (data as any)?.zone;
  const role = (data as any)?.role;
  if (!zone || UNRESTRICTED.has(role)) return null;
  return String(zone);
}
