// Demo eterno con auto-reseteo: cada 8 días se borran los productos y los
// "cambios" (ventas, movimientos de stock, caja, gastos, compras, recibidos) del
// tenant demo, dejándolo limpio. La cuenta demo NUNCA vence.

import { db } from '../db/client.js';

const RESET_DAYS = 8;
const CHUNK = 200;

/** Borra los productos y datos operativos del tenant (sin tocar usuarios/ajustes). */
async function resetDemoData(tenantId: string): Promise<void> {
  // Hijos por FK que pueden no tener ON DELETE CASCADE → se borran primero por id.
  const deleteChildrenOf = async (parentTable: string, childTable: string, fk: string) => {
    const { data: parents } = await db.from(parentTable).select('id').eq('tenant_id', tenantId);
    const ids = (parents ?? []).map((p: any) => p.id);
    for (let i = 0; i < ids.length; i += CHUNK) {
      try { await db.from(childTable).delete().in(fk, ids.slice(i, i + CHUNK)); }
      catch (e: any) { console.warn(`[demo-reset] ${childTable}:`, e?.message); }
    }
  };

  await deleteChildrenOf('invoices', 'invoice_items', 'invoice_id');
  await deleteChildrenOf('purchases', 'purchase_items', 'purchase_id');

  // Tablas con tenant_id directo.
  const tables = [
    'invoices', 'purchases', 'stock_adjustments', 'cash_sessions',
    'expenses', 'received_documents', 'products',
  ];
  for (const t of tables) {
    try { await db.from(t).delete().eq('tenant_id', tenantId); }
    catch (e: any) { console.warn(`[demo-reset] ${t}:`, e?.message); }
  }
}

/**
 * Si el tenant es demo y pasaron ≥8 días desde el último reseteo, limpia sus
 * datos. Reclama el reseteo de forma atómica (update condicional) para que, con
 * varias peticiones concurrentes, solo UNA ejecute el borrado.
 */
export async function maybeResetDemo(tenantId: string, demoResetAt: string | null): Promise<void> {
  const cutoff = new Date(Date.now() - RESET_DAYS * 86_400_000);
  const last = demoResetAt ? new Date(demoResetAt) : new Date(0);
  if (last.getTime() > cutoff.getTime()) return;   // todavía no toca

  // Reclamar: solo el primero que actualice (demo_reset_at < cutoff) hace el reset.
  const { data: claimed } = await db.from('tenants')
    .update({ demo_reset_at: new Date().toISOString() })
    .eq('id', tenantId)
    .lt('demo_reset_at', cutoff.toISOString())
    .select('id');
  if (!claimed || claimed.length === 0) return;     // otro ya lo reclamó

  try {
    await resetDemoData(tenantId);
    console.log(`[demo-reset] tenant ${tenantId} reseteado (cada ${RESET_DAYS} días)`);
  } catch (e: any) {
    console.warn('[demo-reset] error:', e?.message);
  }
}
