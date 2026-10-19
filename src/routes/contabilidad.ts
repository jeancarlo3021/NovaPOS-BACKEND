import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { asegurarCatalogo, crearAsiento, anularAsiento, CATALOGO_BASE } from '../services/contabilidad.js';
import { asentarVenta, asentarGasto, asentarCompra, asentarPendientes } from '../services/contabilidadAuto.js';
import { crearCuentaBancaria, asentarDeposito, asentarLiquidacion, cerrarCajaContable } from '../services/bancos.js';

/**
 * EL MÓDULO CONTABLE.
 *
 * Catálogo de cuentas, libro diario, mayor, balance de comprobación y estado
 * de resultados, con asientos automáticos desde ventas, gastos y compras.
 */
export const contabilidad = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const c2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;

/** Si una cuenta aumenta por el debe. Define el signo del saldo. */
const porDebe = (tipo: string) => tipo === 'activo' || tipo === 'gasto';

// ── CATÁLOGO ──────────────────────────────────────────────────────────────

contabilidad.get('/cuentas', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    /**
     * La creación del catálogo también puede fallar por tabla ausente.
     *
     * Estaba fuera del try que detecta eso, así que sin la migración este
     * endpoint devolvía un 500 — y es justo de él que depende la pantalla
     * para mostrar «falta correr la migración 122». El resultado era la
     * peor combinación: el módulo roto y sin decir por qué.
     */
    try {
      await asegurarCatalogo(tenantId);
    } catch (e: any) {
      if (/chart_accounts/.test(e?.message ?? '')) {
        return ok(c, { sin_tabla: true, cuentas: [], base: CATALOGO_BASE });
      }
      throw e;
    }
    const { data, error } = await db.from('chart_accounts')
      .select('*').eq('tenant_id', tenantId).order('code', { ascending: true });
    if (error) {
      if (/chart_accounts/.test(error.message)) {
        return ok(c, { sin_tabla: true, cuentas: [], base: CATALOGO_BASE });
      }
      throw new Error(error.message);
    }
    return ok(c, { cuentas: data ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

contabilidad.post('/cuentas', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const b = await c.req.json().catch(() => ({} as any));
    const code = String(b?.code ?? '').trim();
    const name = String(b?.name ?? '').trim();
    const type = String(b?.type ?? '').trim();
    if (!/^\d{1,8}$/.test(code)) return fail(c, 'El código debe ser un número de hasta 8 dígitos', 422);
    if (!name) return fail(c, 'Ponele nombre a la cuenta', 422);
    if (!['activo', 'pasivo', 'patrimonio', 'ingreso', 'gasto'].includes(type)) {
      return fail(c, 'El tipo debe ser activo, pasivo, patrimonio, ingreso o gasto', 422);
    }
    const { error } = await db.from('chart_accounts').insert({
      tenant_id: tenantId, code, name, type, postable: b?.postable !== false,
    });
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return fail(c, `Ya existe una cuenta con el código ${code}`, 409);
      throw new Error(error.message);
    }
    return ok(c, { creada: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── LIBRO DIARIO ──────────────────────────────────────────────────────────

contabilidad.get('/diario', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const desde = c.req.query('desde');
    const hasta = c.req.query('hasta');
    let q = db.from('journal_entries').select('*').eq('tenant_id', tenantId)
      .order('fecha', { ascending: false }).order('numero', { ascending: false }).limit(300);
    if (desde) q = q.gte('fecha', desde);
    if (hasta) q = q.lte('fecha', hasta);
    const { data, error } = await q;
    if (error) {
      if (/journal_entries/.test(error.message)) return ok(c, { sin_tabla: true, asientos: [] });
      throw new Error(error.message);
    }
    const ids = ((data ?? []) as any[]).map(x => x.id);
    const { data: lineas } = ids.length
      ? await db.from('journal_lines').select('*').in('entry_id', ids)
      : { data: [] as any[] };
    const porAsiento = new Map<string, any[]>();
    for (const l of ((lineas ?? []) as any[])) {
      porAsiento.set(l.entry_id, [...(porAsiento.get(l.entry_id) ?? []), l]);
    }
    return ok(c, {
      asientos: ((data ?? []) as any[]).map(a => ({
        ...a,
        lineas: (porAsiento.get(a.id) ?? []).sort((x, y) => Number(y.debe) - Number(x.debe)),
        total: c2((porAsiento.get(a.id) ?? []).reduce((s, l) => s + Number(l.debe), 0)),
      })),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

contabilidad.post('/diario', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({} as any));
    const r = await crearAsiento({
      tenantId: c.get('tenantId'), userId: c.get('userId'),
      fecha: String(b?.fecha ?? '').slice(0, 10),
      descripcion: String(b?.descripcion ?? '').trim() || 'Asiento manual',
      lineas: Array.isArray(b?.lineas) ? b.lineas : [],
      sourceType: 'manual',
    });
    return ok(c, r);
  } catch (err: any) { return fail(c, err.message, 422); }
});

contabilidad.post('/diario/:id/anular', async (c) => {
  try {
    const r = await anularAsiento(c.get('tenantId'), c.req.param('id'), c.get('userId'));
    return ok(c, r);
  } catch (err: any) { return fail(c, err.message, 422); }
});

// ── CONTABILIZAR LO PENDIENTE ─────────────────────────────────────────────

contabilidad.post('/contabilizar', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    await asegurarCatalogo(tenantId);
    const b = await c.req.json().catch(() => ({} as any));
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
    const r = await asentarPendientes({
      tenantId, userId: c.get('userId'),
      desde: String(b?.desde ?? hoy.slice(0, 8) + '01'),
      hasta: String(b?.hasta ?? hoy),
      presupuestoMs: 18_000,
    });
    return ok(c, r);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** Contabilizar un documento suelto. */
contabilidad.post('/contabilizar/:tipo/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    await asegurarCatalogo(tenantId);
    const { tipo, id } = c.req.param();
    const fn = tipo === 'venta' ? asentarVenta : tipo === 'gasto' ? asentarGasto
      : tipo === 'compra' ? asentarCompra : null;
    if (!fn) return fail(c, 'Tipo no reconocido: venta, gasto o compra', 422);
    return ok(c, await fn(tenantId, id, userId));
  } catch (err: any) { return fail(c, err.message, 422); }
});

// ── INFORMES ──────────────────────────────────────────────────────────────

/**
 * Los saldos de cada cuenta en un período. Es la base de todo lo demás:
 * el balance de comprobación, el estado de resultados y el balance general
 * son tres formas de mirar esta misma suma.
 */
async function saldos(tenantId: string, desde?: string, hasta?: string) {
  const { data: cuentas } = await db.from('chart_accounts')
    .select('code, name, type, postable').eq('tenant_id', tenantId).order('code');

  let q = db.from('journal_entries').select('id, fecha').eq('tenant_id', tenantId).eq('anulado', false);
  if (desde) q = q.gte('fecha', desde);
  if (hasta) q = q.lte('fecha', hasta);
  const { data: asientos } = await q;
  const ids = ((asientos ?? []) as any[]).map(a => a.id);

  const acum = new Map<string, { debe: number; haber: number }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: ls } = await db.from('journal_lines')
      .select('code, debe, haber').in('entry_id', ids.slice(i, i + 200));
    for (const l of ((ls ?? []) as any[])) {
      const a = acum.get(l.code) ?? { debe: 0, haber: 0 };
      a.debe += Number(l.debe) || 0;
      a.haber += Number(l.haber) || 0;
      acum.set(l.code, a);
    }
  }

  return ((cuentas ?? []) as any[])
    .filter(cu => cu.postable)
    .map(cu => {
      const a = acum.get(cu.code) ?? { debe: 0, haber: 0 };
      const saldo = porDebe(cu.type) ? a.debe - a.haber : a.haber - a.debe;
      return { ...cu, debe: c2(a.debe), haber: c2(a.haber), saldo: c2(saldo) };
    });
}

/** Balance de comprobación: la prueba de que todo cuadra. */
contabilidad.get('/balance', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const filas = await saldos(tenantId, c.req.query('desde'), c.req.query('hasta'));
    const conMovimiento = filas.filter(f => f.debe !== 0 || f.haber !== 0);
    const totalDebe = c2(conMovimiento.reduce((s, f) => s + f.debe, 0));
    const totalHaber = c2(conMovimiento.reduce((s, f) => s + f.haber, 0));
    return ok(c, {
      cuentas: conMovimiento,
      total_debe: totalDebe, total_haber: totalHaber,
      cuadra: totalDebe === totalHaber,
      diferencia: c2(totalDebe - totalHaber),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** Estado de resultados: ingresos menos costos y gastos. */
contabilidad.get('/resultados', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const filas = await saldos(tenantId, c.req.query('desde'), c.req.query('hasta'));
    const ingresos = filas.filter(f => f.type === 'ingreso' && f.saldo !== 0);
    const gastos = filas.filter(f => f.type === 'gasto' && f.saldo !== 0);
    const totalIngresos = c2(ingresos.reduce((s, f) => s + f.saldo, 0));
    const costoVentas = c2(gastos.filter(f => f.code.startsWith('51')).reduce((s, f) => s + f.saldo, 0));
    const gastosOperativos = c2(gastos.filter(f => !f.code.startsWith('51')).reduce((s, f) => s + f.saldo, 0));

    /**
     * Ventas sin costo registrado.
     *
     * Sin esto, un estado de resultados con costo de ventas en cero se lee
     * como un margen del 100%. Decir cuántas ventas están así es lo que
     * evita que alguien tome una decisión con ese número.
     */
    let ventasSinCosto = 0;
    try {
      const { data: conCosto } = await db.from('journal_entries')
        .select('id').eq('tenant_id', tenantId).eq('source_type', 'venta').eq('anulado', false);
      const ids = ((conCosto ?? []) as any[]).map(x => x.id);
      for (let i = 0; i < ids.length; i += 200) {
        const { data: ls } = await db.from('journal_lines')
          .select('entry_id, code').in('entry_id', ids.slice(i, i + 200));
        const conCostoSet = new Set(((ls ?? []) as any[]).filter(l => l.code === '5101').map(l => l.entry_id));
        ventasSinCosto += ids.slice(i, i + 200).filter(x => !conCostoSet.has(x)).length;
      }
    } catch { /* el informe vale igual */ }

    return ok(c, {
      ingresos, gastos,
      total_ingresos: totalIngresos,
      costo_de_ventas: costoVentas,
      utilidad_bruta: c2(totalIngresos - costoVentas),
      gastos_operativos: gastosOperativos,
      utilidad_neta: c2(totalIngresos - costoVentas - gastosOperativos),
      ventas_sin_costo: ventasSinCosto,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** Balance general: qué tiene, qué debe y qué queda. */
contabilidad.get('/situacion', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const filas = await saldos(tenantId, undefined, c.req.query('hasta'));
    const activo = filas.filter(f => f.type === 'activo' && f.saldo !== 0);
    const pasivo = filas.filter(f => f.type === 'pasivo' && f.saldo !== 0);
    const patrimonio = filas.filter(f => f.type === 'patrimonio' && f.saldo !== 0);
    const ingresos = c2(filas.filter(f => f.type === 'ingreso').reduce((s, f) => s + f.saldo, 0));
    const gastos = c2(filas.filter(f => f.type === 'gasto').reduce((s, f) => s + f.saldo, 0));
    const resultado = c2(ingresos - gastos);

    const totalActivo = c2(activo.reduce((s, f) => s + f.saldo, 0));
    const totalPasivo = c2(pasivo.reduce((s, f) => s + f.saldo, 0));
    const totalPatrimonio = c2(patrimonio.reduce((s, f) => s + f.saldo, 0) + resultado);

    return ok(c, {
      activo, pasivo, patrimonio,
      resultado_del_periodo: resultado,
      total_activo: totalActivo,
      total_pasivo: totalPasivo,
      total_patrimonio: totalPatrimonio,
      /** La ecuación contable. Si no cuadra, algo se cargó mal. */
      cuadra: totalActivo === c2(totalPasivo + totalPatrimonio),
      diferencia: c2(totalActivo - totalPasivo - totalPatrimonio),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** Mayor de una cuenta: los movimientos, con saldo corrido. */
contabilidad.get('/mayor/:code', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const code = c.req.param('code');
    const { data: cuenta } = await db.from('chart_accounts')
      .select('*').eq('tenant_id', tenantId).eq('code', code).maybeSingle();
    if (!cuenta) return fail(c, 'Cuenta no encontrada', 404);

    let q = db.from('journal_entries').select('id, numero, fecha, descripcion')
      .eq('tenant_id', tenantId).eq('anulado', false).order('fecha').order('numero');
    const desde = c.req.query('desde'); const hasta = c.req.query('hasta');
    if (desde) q = q.gte('fecha', desde);
    if (hasta) q = q.lte('fecha', hasta);
    const { data: asientos } = await q;
    const porId = new Map(((asientos ?? []) as any[]).map(a => [a.id, a]));
    const ids = [...porId.keys()];

    const movs: any[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data: ls } = await db.from('journal_lines')
        .select('*').eq('code', code).in('entry_id', ids.slice(i, i + 200));
      for (const l of ((ls ?? []) as any[])) {
        const a = porId.get(l.entry_id);
        movs.push({
          fecha: a?.fecha, numero: a?.numero, descripcion: l.detalle || a?.descripcion,
          debe: c2(l.debe), haber: c2(l.haber),
        });
      }
    }
    movs.sort((x, y) => String(x.fecha).localeCompare(String(y.fecha)) || x.numero - y.numero);

    let corrido = 0;
    const conSaldo = movs.map(m => {
      corrido += porDebe((cuenta as any).type) ? m.debe - m.haber : m.haber - m.debe;
      return { ...m, saldo: c2(corrido) };
    });
    return ok(c, { cuenta, movimientos: conSaldo, saldo_final: c2(corrido) });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// BANCOS
// ══════════════════════════════════════════════════════════════════════════

contabilidad.get('/bancos', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('bank_accounts')
      .select('*').eq('tenant_id', tenantId).order('code');
    if (error) {
      if (/bank_accounts/.test(error.message)) return ok(c, { sin_tabla: true, cuentas: [] });
      throw new Error(error.message);
    }
    /** El saldo de cada una, para no tener que ir al mayor por cada banco. */
    const cuentas: any[] = [];
    for (const b of ((data ?? []) as any[])) {
      const { data: ls } = await db.from('journal_lines')
        .select('debe, haber, conciliado').eq('tenant_id', tenantId).eq('code', b.code);
      const filas = (ls ?? []) as any[];
      const saldo = filas.reduce((s2, l) => s2 + Number(l.debe) - Number(l.haber), 0);
      cuentas.push({
        ...b,
        saldo: Math.round(saldo * 100) / 100,
        movimientos: filas.length,
        sin_conciliar: filas.filter(l => !l.conciliado).length,
      });
    }
    return ok(c, { cuentas });
  } catch (err: any) { return fail(c, err.message, 500); }
});

contabilidad.post('/bancos', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    await asegurarCatalogo(tenantId);
    const b = await c.req.json().catch(() => ({} as any));
    if (!String(b?.nombre ?? '').trim()) return fail(c, 'Ponele nombre a la cuenta', 422);
    return ok(c, await crearCuentaBancaria(tenantId, b));
  } catch (err: any) { return fail(c, err.message, 422); }
});

/** PUT /bancos/:id — cambiar a qué métodos de cobro atiende. */
contabilidad.put('/bancos/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const b = await c.req.json().catch(() => ({} as any));
    const parche: any = { };
    if (Array.isArray(b?.metodos)) parche.metodos = b.metodos.map((m: any) => String(m).toLowerCase());
    if (typeof b?.nombre === 'string') parche.nombre = b.nombre.trim();
    if (typeof b?.activa === 'boolean') parche.activa = b.activa;
    const { error } = await db.from('bank_accounts')
      .update(parche).eq('id', c.req.param('id')).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { guardado: true });
  } catch (err: any) { return fail(c, err.message, 422); }
});

contabilidad.post('/bancos/deposito', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({} as any));
    return ok(c, await asentarDeposito({
      tenantId: c.get('tenantId'), userId: c.get('userId'),
      bankAccountId: String(b?.bank_account_id ?? ''),
      monto: Number(b?.monto), fecha: b?.fecha, referencia: b?.referencia,
    }));
  } catch (err: any) { return fail(c, err.message, 422); }
});

/**
 * POST /bancos/liquidacion — el depósito del procesador de tarjetas.
 *
 * Si no se dice la comisión pero sí el neto, se deduce: lo que el negocio
 * tiene a mano es el comprobante del depósito, no el porcentaje de memoria.
 */
contabilidad.post('/bancos/liquidacion', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({} as any));
    const bruto = Number(b?.bruto);
    let comision = Number(b?.comision);
    if (!Number.isFinite(comision) && Number.isFinite(Number(b?.neto))) {
      comision = bruto - Number(b.neto);
    }
    return ok(c, await asentarLiquidacion({
      tenantId: c.get('tenantId'), userId: c.get('userId'),
      bankAccountId: b?.bank_account_id || undefined,
      bruto, comision: Number.isFinite(comision) ? comision : 0,
      fecha: b?.fecha, referencia: b?.referencia,
    }));
  } catch (err: any) { return fail(c, err.message, 422); }
});

/** Lo que está esperando que el procesador lo deposite. */
contabilidad.get('/bancos/por-liquidar', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data } = await db.from('journal_lines')
      .select('debe, haber').eq('tenant_id', tenantId).eq('code', '1106');
    const filas = (data ?? []) as any[];
    const saldo = filas.reduce((s2, l) => s2 + Number(l.debe) - Number(l.haber), 0);
    return ok(c, { saldo: Math.round(saldo * 100) / 100, movimientos: filas.length });
  } catch (err: any) { return fail(c, err.message, 500); }
});

contabilidad.post('/caja/cerrar', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({} as any));
    return ok(c, await cerrarCajaContable({
      tenantId: c.get('tenantId'), userId: c.get('userId'),
      sessionId: String(b?.session_id ?? ''), contado: Number(b?.contado),
    }));
  } catch (err: any) { return fail(c, err.message, 422); }
});

// ══════════════════════════════════════════════════════════════════════════
// CONCILIACIÓN
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /conciliacion/:code — los movimientos de una cuenta, marcados o no.
 *
 * El saldo conciliado es el que debería coincidir con el estado del banco.
 * Mostrarlo al lado del contable es lo que convierte «no cuadra» en «faltan
 * estas tres partidas».
 */
contabilidad.get('/conciliacion/:code', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const code = c.req.param('code');
    let q = db.from('journal_entries').select('id, numero, fecha, descripcion')
      .eq('tenant_id', tenantId).eq('anulado', false).order('fecha');
    const desde = c.req.query('desde'); const hasta = c.req.query('hasta');
    if (desde) q = q.gte('fecha', desde);
    if (hasta) q = q.lte('fecha', hasta);
    const { data: asientos } = await q;
    const porId = new Map(((asientos ?? []) as any[]).map(a => [a.id, a]));
    const ids = [...porId.keys()];

    const movs: any[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data: ls } = await db.from('journal_lines')
        .select('*').eq('code', code).in('entry_id', ids.slice(i, i + 200));
      for (const l of ((ls ?? []) as any[])) {
        const a = porId.get(l.entry_id);
        movs.push({
          id: l.id, fecha: a?.fecha, numero: a?.numero,
          descripcion: l.detalle || a?.descripcion,
          debe: Number(l.debe), haber: Number(l.haber), conciliado: !!l.conciliado,
        });
      }
    }
    movs.sort((x, y) => String(x.fecha).localeCompare(String(y.fecha)) || x.numero - y.numero);
    const c2n = (n: number) => Math.round(n * 100) / 100;
    return ok(c, {
      movimientos: movs,
      saldo_contable: c2n(movs.reduce((s2, m) => s2 + m.debe - m.haber, 0)),
      saldo_conciliado: c2n(movs.filter(m => m.conciliado).reduce((s2, m) => s2 + m.debe - m.haber, 0)),
      sin_conciliar: movs.filter(m => !m.conciliado).length,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** POST /conciliacion — marcar o desmarcar partidas. */
contabilidad.post('/conciliacion', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const b = await c.req.json().catch(() => ({} as any));
    const ids: string[] = Array.isArray(b?.ids) ? b.ids : [];
    if (ids.length === 0) return fail(c, 'No mandaste ninguna partida', 422);
    const marcar = b?.conciliado !== false;
    const { error } = await db.from('journal_lines')
      .update({ conciliado: marcar, conciliado_at: marcar ? new Date().toISOString() : null })
      .eq('tenant_id', tenantId).in('id', ids);
    if (error) throw new Error(error.message);
    return ok(c, { actualizadas: ids.length, conciliado: marcar });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default contabilidad;
