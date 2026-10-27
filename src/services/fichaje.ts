import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from '../db/client.js';

/**
 * FICHAJE: marcar entrada y salida.
 *
 * Dos formas de decir «soy yo»:
 *  - un CÓDIGO personal, que funciona en cualquier aparato (el teléfono viejo
 *    del local, la tablet de la entrada, la computadora de la caja);
 *  - la HUELLA o la CARA del teléfono, que es más cómoda pero solo sirve en el
 *    aparato donde se registró.
 *
 * Las dos identifican al empleado en el SERVIDOR. El endpoint viejo recibía el
 * `employee_id` en el cuerpo y marcaba sin preguntar nada: con la pantalla
 * abierta, cualquiera podía marcarle la entrada a un compañero que todavía no
 * llegaba.
 */

/** Hash del PIN: scrypt con salt propio. Formato `salt:hash` en hexadecimal. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(String(pin), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Compara sin filtrar tiempo: un `===` deja medir cuántos dígitos acertó. */
export function pinCoincide(pin: string, guardado: string | null | undefined): boolean {
  if (!guardado || !guardado.includes(':')) return false;
  try {
    const [saltHex, hashHex] = guardado.split(':');
    const esperado = Buffer.from(hashHex, 'hex');
    const calculado = scryptSync(String(pin), Buffer.from(saltHex, 'hex'), esperado.length);
    return timingSafeEqual(esperado, calculado);
  } catch { return false; }
}

/** Fecha del día en Costa Rica: marcar a las 11 p.m. no es «mañana». */
export function hoyCR(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Costa_Rica', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export interface ResultadoFichaje {
  accion: 'entrada' | 'salida';
  empleado: { id: string; full_name: string; position?: string | null };
  hora: string;
  /** Horas trabajadas, al marcar la salida. */
  horas?: number;
  registro: any;
}

/**
 * Marca lo que corresponda: si no hay entrada hoy, entra; si hay, sale.
 *
 * No hay dos botones a propósito. El que ficha a las 6 a.m. medio dormido no
 * tiene que elegir nada, y el error clásico —darle a «entrada» cuando se va—
 * deja de existir.
 */
export async function marcar(opts: {
  tenantId: string;
  empleado: { id: string; full_name: string; position?: string | null };
  metodo: 'pin' | 'biometria' | 'manual';
  device?: string | null;
  markedBy?: string | null;
}): Promise<ResultadoFichaje> {
  const { tenantId, empleado } = opts;
  const dia = hoyCR();
  const ahora = new Date().toISOString();

  const { data: existente } = await db.from('attendance_records')
    .select('*').eq('tenant_id', tenantId).eq('employee_id', empleado.id).eq('date', dia).maybeSingle();

  /*
   * Las columnas de auditoría son de la migración 125. Si todavía no se corrió,
   * el fichaje tiene que funcionar igual: lo único que se pierde es el detalle
   * de CÓMO se marcó, no la marca.
   */
  const extra = { method: opts.metodo, device: opts.device ?? null, marked_by: opts.markedBy ?? null };
  const guardar = async (fila: any) => {
    const r = await db.from('attendance_records').insert({ ...fila, ...extra }).select().single();
    if (r.error && /method|device|marked_by/i.test(r.error.message)) {
      return await db.from('attendance_records').insert(fila).select().single();
    }
    return r;
  };

  if (!existente) {
    const { data, error } = await guardar({
      tenant_id: tenantId, employee_id: empleado.id, date: dia, clock_in: ahora,
    });
    if (error) throw new Error(error.message);
    return { accion: 'entrada', empleado, hora: ahora, registro: data };
  }

  if ((existente as any).clock_out) {
    // Ya cerró el día. Volver a marcar no puede pisar la salida anterior.
    throw new Error(`${empleado.full_name} ya marcó entrada y salida hoy.`);
  }

  const entrada = new Date((existente as any).clock_in);
  const horas = Math.round(((Date.now() - entrada.getTime()) / 3_600_000) * 100) / 100;
  const patch: any = { clock_out: ahora, hours_worked: horas };
  let r = await db.from('attendance_records').update({ ...patch, method: opts.metodo })
    .eq('id', (existente as any).id).select().single();
  if (r.error && /method/i.test(r.error.message)) {
    r = await db.from('attendance_records').update(patch).eq('id', (existente as any).id).select().single();
  }
  if (r.error) throw new Error(r.error.message);
  return { accion: 'salida', empleado, hora: ahora, horas, registro: r.data };
}

/** Busca al empleado por su código dentro del negocio. */
export async function empleadoPorPin(tenantId: string, pin: string) {
  const { data } = await db.from('employees')
    .select('id, full_name, position, status, attendance_pin_hash')
    .eq('tenant_id', tenantId).eq('status', 'active');
  for (const e of (data ?? []) as any[]) {
    if (pinCoincide(pin, e.attendance_pin_hash)) return e;
  }
  return null;
}
