/**
 * Hasta cuándo vale una suscripción según el CICLO de su plan.
 *
 * `lifetime` (Vitalicio) devuelve null: sin fecha de fin, que es como el sistema
 * representa «no vence» —el control de acceso deja pasar cualquier suscripción
 * sin `ends_at`—.
 *
 * Esta cuenta estaba escrita suelta en cuatro lugares (cambiar de plan, aplicar
 * un pago, crear una sucursal, crear la actividad de una sociedad) y en todos
 * decía «anual → 365, lo demás → 30». Con eso, un plan vitalicio quedaba
 * venciendo a los treinta días: el plan decía una cosa y el negocio se bloqueaba
 * igual.
 */
export function esVitalicio(cycle: any): boolean {
  return String(cycle ?? '').trim().toLowerCase() === 'lifetime';
}

/** Días que dura un ciclo. Vitalicio no tiene: usar `finSegunCiclo`. */
export function diasDelCiclo(cycle: any): number {
  return String(cycle ?? 'monthly').trim().toLowerCase() === 'yearly' ? 365 : 30;
}

/**
 * Fecha de vencimiento, contada desde `desde` (por defecto, ahora).
 * Devuelve null cuando el plan es vitalicio.
 */
export function finSegunCiclo(cycle: any, desde: Date | number = Date.now()): Date | null {
  if (esVitalicio(cycle)) return null;
  const base = typeof desde === 'number' ? desde : desde.getTime();
  return new Date(base + diasDelCiclo(cycle) * 86_400_000);
}

/** Igual que `finSegunCiclo`, en texto ISO (o null). */
export function finISOSegunCiclo(cycle: any, desde: Date | number = Date.now()): string | null {
  return finSegunCiclo(cycle, desde)?.toISOString() ?? null;
}
