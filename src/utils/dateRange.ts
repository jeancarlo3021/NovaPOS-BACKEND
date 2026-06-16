// Helpers para filtros de rango de fechas en reportes/listados.
//
// El frontend suele enviar `to` como fecha sin hora ("2026-06-15"), que
// Postgres interpreta como medianoche (00:00:00). Eso excluye TODAS las filas
// del mismo día emitidas después de medianoche (el caso típico: las ventas de
// "hoy" no aparecen). Normalizamos `to` al final del día.
export function endOfDay(to?: string): string | undefined {
  if (!to) return to;
  // Si ya trae hora (contiene 'T' o espacio), lo dejamos tal cual.
  if (to.length <= 10) return `${to}T23:59:59.999`;
  return to;
}
