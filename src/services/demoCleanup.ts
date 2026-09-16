import { db } from '../db/client.js';

/**
 * Borra las demos que nadie convirtió en cliente.
 *
 * Se ejecuta desde el cron. Solo toca negocios marcados `is_demo` y cuya
 * solicitud tiene `purge_on` vencido y ninguna conversión: un negocio real
 * jamás entra acá, aunque haya nacido de una prueba.
 */
export async function purgeExpiredDemos(opts: { dryRun?: boolean } = {}) {
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
  const { DEMO_PURGE_DAYS } = await import('../routes/demoRequests.js');
  const plazoMs = DEMO_PURGE_DAYS * 86400000;

  // Todas las demos sin convertir: el plazo se decide abajo, una por una.
  const { data: vencidas, error } = await db.from('demo_requests')
    .select('id, number, business_name, demo_tenant_id, purge_on, expires_on, converted_at')
    .not('demo_tenant_id', 'is', null)
    .is('converted_at', null)
    .limit(500);
  if (error) throw new Error(error.message);

  const borradas: string[] = [];
  const saltadas: Array<{ demo: string; motivo: string }> = [];
  /**
   * Las que TODAVÍA no toca borrar, con la fecha en que les toca.
   *
   * Sin esto, «no se borra ninguna» y «no le toca a ninguna» se veían igual: una
   * lista vacía. Saber cuándo le toca a cada una es lo que permite distinguir un
   * proceso que no corre de uno que corre y no tiene nada que hacer.
   */
  const pendientes: Array<{ demo: string; negocio: string; borra_el: string }> = [];

  for (const r of (vencidas ?? []) as any[]) {
    /**
     * El plazo se cuenta desde el vencimiento REAL de su suscripción.
     *
     * La fecha de borrado que se guardó al crear la demo queda vieja si después
     * se le extendió la prueba desde «Renovar»: contar desde ahí borraría una
     * demo que alguien decidió alargar. El vencimiento de la suscripción es el
     * mismo contador que el negocio ve llegar a 0.
     */
    const { data: sub } = await db.from('subscriptions')
      .select('ends_at').eq('tenant_id', r.demo_tenant_id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    const vence = (sub as any)?.ends_at
      ? new Date((sub as any).ends_at).getTime()
      : r.expires_on ? new Date(`${r.expires_on}T23:59:59`).getTime() : null;
    const borraEl = vence != null ? vence + plazoMs
      : r.purge_on ? new Date(`${r.purge_on}T00:00:00`).getTime() : null;
    const toca = borraEl != null && borraEl <= Date.now();
    if (!toca) {
      pendientes.push({
        demo: r.number ?? r.id,
        negocio: r.business_name ?? '',
        borra_el: borraEl != null ? new Date(borraEl).toISOString().slice(0, 10) : 'sin fecha definida',
      });
      continue;
    }

    // Segunda verificación contra el negocio: si dejó de ser demo (lo pasaron a
    // cliente por otro lado), NO se toca.
    const { data: t } = await db.from('tenants')
      .select('id, is_demo, name').eq('id', r.demo_tenant_id).maybeSingle();
    if (!t) {
      // El negocio ya no existe: solo se cierra la solicitud.
      if (!opts.dryRun) {
        await db.from('demo_requests').update({
          status: 'vencida', updated_at: new Date().toISOString(),
        }).eq('id', r.id);
      }
      saltadas.push({ demo: r.number ?? r.id, motivo: 'el negocio ya no existía' });
      continue;
    }
    if ((t as any).is_demo !== true) {
      saltadas.push({ demo: r.number ?? r.id, motivo: 'ya no es demo (se convirtió en cliente)' });
      continue;
    }

    if (opts.dryRun) { borradas.push(r.number ?? r.id); continue; }

    // Los usuarios del negocio de prueba primero: dejarlos sueltos significa que
    // alguien podría seguir entrando a un negocio que ya no existe.
    const { data: users } = await db.from('users')
      .select('id').eq('tenant_id', r.demo_tenant_id);
    for (const u of (users ?? []) as any[]) {
      try { await db.auth.admin.deleteUser(u.id); } catch { /* ya podía no existir */ }
      try { await db.from('user_tenants').delete().eq('user_id', u.id); } catch { /* ignore */ }
      try { await db.from('users').delete().eq('id', u.id); } catch { /* ignore */ }
    }

    try { await db.from('subscriptions').delete().eq('tenant_id', r.demo_tenant_id); } catch { /* ignore */ }
    const { error: delErr } = await db.from('tenants').delete().eq('id', r.demo_tenant_id);
    if (delErr) {
      saltadas.push({ demo: r.number ?? r.id, motivo: delErr.message });
      continue;
    }

    await db.from('demo_requests').update({
      status: 'vencida', demo_tenant_id: null, updated_at: new Date().toISOString(),
    }).eq('id', r.id);
    borradas.push(r.number ?? r.id);
  }

  return { revisadas: (vencidas ?? []).length, borradas, saltadas, pendientes };
}
