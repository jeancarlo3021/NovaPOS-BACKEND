import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

// Retenciones para el D-150 (Resumen Anual de Retenciones — Hacienda CR).
const taxWithholdings = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// Solo admin/gerente/contador/dueño manejan el D-150.
const D150_ROLES = new Set(['owner', 'admin', 'gerente', 'contador']);

const Schema = z.object({
  period_year: z.number().int(),
  concept: z.string().min(1),
  beneficiary_id_type: z.string().optional().nullable(),
  beneficiary_id: z.string().optional().nullable(),
  beneficiary_name: z.string().min(1),
  base_amount: z.number().nonnegative(),
  withheld_amount: z.number().nonnegative(),
  paid_at: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
});

// GET /?year=2026 — lista de retenciones del año.
taxWithholdings.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const year = Number(c.req.query('year')) || new Date().getFullYear();
    const { data, error } = await db.from('tax_withholdings')
      .select('*').eq('tenant_id', tenantId).eq('period_year', year)
      .order('beneficiary_name', { ascending: true });
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /d150?year=2026 — resumen del formulario: agrupado por beneficiario y por
// concepto, con los totales que van en la declaración.
taxWithholdings.get('/d150', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const year = Number(c.req.query('year')) || new Date().getFullYear();
    const { data, error } = await db.from('tax_withholdings')
      .select('*').eq('tenant_id', tenantId).eq('period_year', year);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as any[];

    // Agrupado por beneficiario (cédula) — cada uno con su base y retención.
    const byBenef = new Map<string, any>();
    const byConcept = new Map<string, { concept: string; base: number; withheld: number; count: number }>();
    let totalBase = 0, totalWithheld = 0;
    for (const r of rows) {
      const base = Number(r.base_amount ?? 0), wh = Number(r.withheld_amount ?? 0);
      totalBase += base; totalWithheld += wh;
      const bk = String(r.beneficiary_id || r.beneficiary_name || '—');
      const b = byBenef.get(bk) ?? {
        beneficiary_id_type: r.beneficiary_id_type ?? null, beneficiary_id: r.beneficiary_id ?? null,
        beneficiary_name: r.beneficiary_name ?? '—', base: 0, withheld: 0, count: 0,
      };
      b.base += base; b.withheld += wh; b.count++;
      byBenef.set(bk, b);
      const ck = String(r.concept ?? '—');
      const cc = byConcept.get(ck) ?? { concept: ck, base: 0, withheld: 0, count: 0 };
      cc.base += base; cc.withheld += wh; cc.count++;
      byConcept.set(ck, cc);
    }
    return ok(c, {
      year,
      by_beneficiary: [...byBenef.values()].sort((a, b) => b.withheld - a.withheld),
      by_concept: [...byConcept.values()].sort((a, b) => b.withheld - a.withheld),
      totals: { base: totalBase, withheld: totalWithheld, count: rows.length },
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST / — registrar una retención (solo roles autorizados).
taxWithholdings.post('/', async (c) => {
  try {
    if (!D150_ROLES.has(String(c.get('role') ?? ''))) return fail(c, 'Solo administrador, gerente o contador.', 403);
    const parsed = Schema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.errors[0]?.message ?? 'Datos inválidos', 422);
    const row = { ...parsed.data, tenant_id: c.get('tenantId'), created_by: c.get('userId') ?? null };
    const { data, error } = await db.from('tax_withholdings').insert(row).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// DELETE /:id — eliminar una retención (solo roles autorizados).
taxWithholdings.delete('/:id', async (c) => {
  try {
    if (!D150_ROLES.has(String(c.get('role') ?? ''))) return fail(c, 'Solo administrador, gerente o contador.', 403);
    const { id } = c.req.param();
    const { error } = await db.from('tax_withholdings').delete().eq('id', id).eq('tenant_id', c.get('tenantId'));
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default taxWithholdings;
