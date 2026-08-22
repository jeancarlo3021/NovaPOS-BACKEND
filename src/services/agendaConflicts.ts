import { db } from '../db/client.js';

/**
 * Choques de agenda: una persona no puede tener dos cosas a la misma hora.
 *
 * La agenda mezcla entregas (agent_orders) y tareas (agenda_tasks), así que el
 * choque se busca en las DOS tablas: de nada sirve bloquear dos entregas a las
 * 10:00 si igual se le puede meter un mandado a esa misma hora.
 *
 * Regla: misma persona + mismo día + misma hora exacta (HH:MM). Sin hora no hay
 * choque posible — es justamente lo que todavía no está agendado.
 */
export interface ConflictQuery {
  tenantId: string;
  assignedTo?: string | null;
  date?: string | null;
  time?: string | null;
  /** Ids a ignorar: el propio registro que se está moviendo. */
  ignoreOrderId?: string | null;
  ignoreTaskId?: string | null;
}

const hhmm = (t?: string | null) => (t ? String(t).slice(0, 5) : null);

/** Devuelve el texto del choque, o null si la hora está libre. */
export async function findAgendaConflict(q: ConflictQuery): Promise<string | null> {
  const time = hhmm(q.time);
  if (!q.assignedTo || !q.date || !time) return null;

  const { data: orders } = await db.from('agent_orders')
    .select('id, number, scheduled_time, customer_name, status')
    .eq('tenant_id', q.tenantId)
    .eq('assigned_to', q.assignedTo)
    .eq('scheduled_date', q.date)
    .neq('status', 'cancelled')
    .limit(200);

  for (const o of (orders ?? []) as any[]) {
    if (q.ignoreOrderId && String(o.id) === String(q.ignoreOrderId)) continue;
    if (hhmm(o.scheduled_time) === time) {
      return `Ya tiene la entrega ${o.number ?? ''}${o.customer_name ? ` (${o.customer_name})` : ''} a las ${time}.`;
    }
  }

  // La tabla de tareas puede no existir todavía (migración 94 sin correr): que
  // falte no puede impedir agendar una entrega.
  try {
    const { data: tasks, error } = await db.from('agenda_tasks')
      .select('id, title, scheduled_time, status')
      .eq('tenant_id', q.tenantId)
      .eq('assigned_to', q.assignedTo)
      .eq('scheduled_date', q.date)
      .neq('status', 'cancelled')
      .limit(200);
    if (error) return null;
    for (const t of (tasks ?? []) as any[]) {
      if (q.ignoreTaskId && String(t.id) === String(q.ignoreTaskId)) continue;
      if (hhmm(t.scheduled_time) === time) {
        return `Ya tiene la tarea "${t.title}" a las ${time}.`;
      }
    }
  } catch { /* sin tabla de tareas */ }

  return null;
}
