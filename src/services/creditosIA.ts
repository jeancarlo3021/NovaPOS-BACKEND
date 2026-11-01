import { db } from '../db/client.js';

/**
 * CRÉDITOS DE IA — cuántas consultas al modelo incluye el plan por mes.
 *
 * Cada consulta al modelo cuesta plata de verdad, y el que la paga es el que
 * vende el sistema, no el negocio que pregunta. Sin un tope, un solo cliente
 * curioso con el chat abierto puede costar más que su mensualidad.
 *
 * El tope vive en el PLAN (`features.ia_creditos`), junto a los otros límites
 * —usuarios, productos, órdenes—, y se controla desde el panel de planes:
 *   · 0 o sin poner → el negocio no usa el modelo. Sigue teniendo el asistente,
 *     que contesta con los datos de su base; simplemente no gasta.
 *   · un número     → consultas por mes, se reinician el día 1.
 *   · -1            → sin tope (para el plan del administrador).
 *
 * Lo que NO cuenta: todo lo que resuelve la base. Preguntar «cuánto vendí» no
 * gasta un crédito porque no toca ningún modelo. Tampoco cuenta lo que sale de
 * la caché: si la respuesta ya estaba, no se pagó nada.
 */

export const SIN_TOPE = -1;

export interface EstadoCreditos {
  /** Lo que incluye el plan. -1 = sin tope. 0 = el modelo no se usa. */
  incluidos: number;
  /** Consumidas este mes. */
  usadas: number;
  /** Lo que queda. null cuando no hay tope. */
  disponibles: number | null;
  /** Primer día del próximo mes: cuándo se reinician. */
  reinicia: string;
}

/** Mes corriente en Costa Rica, como «2026-10». El corte es el día 1 local. */
function mesCR(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Costa_Rica', year: 'numeric', month: '2-digit',
  }).format(d).slice(0, 7);
}

function primeroDelProximoMes(): string {
  const hoy = new Date(`${mesCR()}-01T12:00:00Z`);
  hoy.setUTCMonth(hoy.getUTCMonth() + 1);
  return hoy.toISOString().slice(0, 10);
}

/** Cuántos créditos incluye el plan del negocio. */
export async function creditosDelPlan(tenantId: string): Promise<number> {
  try {
    const { data: t } = await db.from('tenants').select('plan_id').eq('id', tenantId).maybeSingle();
    const planId = (t as any)?.plan_id;
    if (!planId) return 0;
    const { data: p } = await db.from('subscription_plans')
      .select('features').eq('id', planId).maybeSingle();
    const f: any = (p as any)?.features ?? {};
    // El administrador de la plataforma no se limita a sí mismo.
    if (f.admin_dashboard === true) return SIN_TOPE;
    const n = Number(f.ia_creditos);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

/** Sin la tabla de consumo (migración sin correr) no se bloquea a nadie. */
let tablaUsoViva = true;

async function usadasEnElMes(tenantId: string): Promise<number> {
  if (!tablaUsoViva) return 0;
  try {
    const { data, error } = await db.from('ia_uso')
      .select('consultas').eq('tenant_id', tenantId).eq('mes', mesCR()).maybeSingle();
    if (error) { if (/ia_uso/i.test(error.message)) tablaUsoViva = false; return 0; }
    return Number((data as any)?.consultas ?? 0);
  } catch { return 0; }
}

export async function estadoCreditos(tenantId: string): Promise<EstadoCreditos> {
  const incluidos = await creditosDelPlan(tenantId);
  const usadas = await usadasEnElMes(tenantId);
  return {
    incluidos,
    usadas,
    disponibles: incluidos === SIN_TOPE ? null : Math.max(0, incluidos - usadas),
    reinicia: primeroDelProximoMes(),
  };
}

/**
 * ¿Puede gastar una consulta? Si puede, la descuenta.
 *
 * Se descuenta ANTES de llamar al modelo, no después: si se descontara al
 * volver, dos pestañas preguntando a la vez pasarían las dos el control y el
 * mes cerraría con más consultas que créditos.
 *
 * Si la consulta termina fallando, el crédito se devuelve con `devolver`.
 */
export async function tomarCredito(tenantId: string): Promise<{ ok: boolean; estado: EstadoCreditos }> {
  const estado = await estadoCreditos(tenantId);
  if (estado.incluidos === SIN_TOPE) return { ok: true, estado };
  if (estado.incluidos <= 0) return { ok: false, estado };
  if ((estado.disponibles ?? 0) <= 0) return { ok: false, estado };

  if (tablaUsoViva) {
    try {
      const { error } = await db.from('ia_uso').upsert({
        tenant_id: tenantId, mes: mesCR(), suma: 1,
        actualizado: new Date().toISOString(),
      }, { onConflict: 'tenant_id,mes' });
      if (error && /ia_uso/i.test(error.message)) tablaUsoViva = false;
    } catch { /* no se bloquea una consulta por no poder contarla */ }
  }
  return {
    ok: true,
    estado: { ...estado, usadas: estado.usadas + 1, disponibles: estado.disponibles == null ? null : estado.disponibles - 1 },
  };
}

/** La consulta falló: el crédito no se cobra. */
export async function devolverCredito(tenantId: string): Promise<void> {
  if (!tablaUsoViva) return;
  try {
    await db.from('ia_uso').upsert({
      tenant_id: tenantId, mes: mesCR(), suma: -1,
      actualizado: new Date().toISOString(),
    }, { onConflict: 'tenant_id,mes' });
  } catch { /* queda cobrada: es un crédito, no una factura */ }
}
