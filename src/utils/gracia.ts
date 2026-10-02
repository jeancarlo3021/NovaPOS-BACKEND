/**
 * EL TIEMPO DE GRACIA: cuánto sigue funcionando el sistema después de vencer.
 *
 * Al vencer la suscripción el negocio NO se apaga de golpe: tiene estos días
 * para pagar. Pasados, el API deja de aceptar cambios (POST/PUT/DELETE) y el
 * sistema queda en SOLO LECTURA: se puede ver todo, pero no vender ni facturar.
 *
 * El número estaba escrito dentro del middleware que corta el acceso, así que
 * los avisos de WhatsApp no podían decir cuántos días quedan sin repetirlo. Dos
 * copias del mismo número terminan diciéndole al cliente una fecha y cortándole
 * en otra, que es la peor forma de enterarse.
 */
export const DIAS_DE_GRACIA = 6;

/**
 * Días de gracia que quedan, contando por día calendario.
 *
 * `diasHastaVencer` es lo que falta para el vencimiento (0 = vence hoy,
 * negativo = ya venció). Devuelve `DIAS_DE_GRACIA` el día del vencimiento y 0 el
 * día en que el sistema pasa a solo lectura.
 */
export function graciaRestante(diasHastaVencer: number): number {
  return DIAS_DE_GRACIA + diasHastaVencer;
}
