import { db } from '../db/client.js';

/**
 * CONTABILIDAD POR PARTIDA DOBLE.
 *
 * ── La única regla que no se negocia ─────────────────────────────────────
 * Un asiento donde el debe no es igual al haber NO SE GUARDA. Se valida acá,
 * en el único lugar por donde pasan todos: si cada pantalla validara por su
 * cuenta, alcanza con que una se olvide para que el balance deje de cuadrar,
 * y eso se descubre meses después sin saber cuál asiento fue.
 */

export interface LineaAsiento {
  code: string;
  debe?: number;
  haber?: number;
  detalle?: string;
}

/** Redondeo a céntimos. Los flotantes dejan diferencias de 0,00001 que
 *  hacen fallar la validación por un error que no existe. */
const c2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * EL CATÁLOGO BASE, para Costa Rica.
 *
 * Mínimo a propósito: veintipico de cuentas que cubren lo que el sistema
 * sabe generar. Un catálogo de trescientas cuentas copiado de un libro se ve
 * completo y deja al dueño sin saber cuál usar; el contador agrega las suyas
 * cuando las necesita.
 */
export const CATALOGO_BASE: Array<{ code: string; name: string; type: string; postable?: boolean }> = [
  { code: '1',    name: 'ACTIVO',                        type: 'activo',     postable: false },
  { code: '11',   name: 'Activo circulante',             type: 'activo',     postable: false },
  { code: '1101', name: 'Caja',                          type: 'activo' },
  { code: '1102', name: 'Bancos',                        type: 'activo' },
  { code: '1103', name: 'Cuentas por cobrar',            type: 'activo' },
  { code: '1104', name: 'Inventario',                    type: 'activo' },
  { code: '1105', name: 'IVA pagado (crédito fiscal)',   type: 'activo' },
  /**
   * El dinero de las tarjetas, mientras el procesador no lo deposita.
   *
   * No es banco todavía: son días de diferencia y el monto que llega es
   * neto de comisión. Sin esta cuenta, el saldo bancario quedaba inflado
   * desde la venta hasta el depósito.
   */
  { code: '1106', name: 'Tarjetas por liquidar',         type: 'activo' },
  { code: '2',    name: 'PASIVO',                        type: 'pasivo',     postable: false },
  { code: '21',   name: 'Pasivo circulante',             type: 'pasivo',     postable: false },
  { code: '2101', name: 'Cuentas por pagar',             type: 'pasivo' },
  { code: '2102', name: 'IVA cobrado (débito fiscal)',   type: 'pasivo' },
  { code: '2103', name: 'Impuestos por pagar',           type: 'pasivo' },
  { code: '3',    name: 'PATRIMONIO',                    type: 'patrimonio', postable: false },
  { code: '3101', name: 'Capital',                       type: 'patrimonio' },
  { code: '3102', name: 'Resultados acumulados',         type: 'patrimonio' },
  { code: '4',    name: 'INGRESOS',                      type: 'ingreso',    postable: false },
  { code: '4101', name: 'Ventas',                        type: 'ingreso' },
  { code: '4102', name: 'Devoluciones sobre ventas',     type: 'ingreso' },
  { code: '5',    name: 'COSTOS Y GASTOS',               type: 'gasto',      postable: false },
  { code: '5101', name: 'Costo de ventas',               type: 'gasto' },
  { code: '5201', name: 'Gastos generales',              type: 'gasto' },
  { code: '5202', name: 'Salarios y cargas sociales',    type: 'gasto' },
  { code: '5203', name: 'Alquiler',                      type: 'gasto' },
  { code: '5204', name: 'Servicios públicos',            type: 'gasto' },
  { code: '5205', name: 'Combustible y transporte',      type: 'gasto' },
  { code: '5206', name: 'Comisiones bancarias',          type: 'gasto' },
  { code: '5207', name: 'Faltantes y sobrantes de caja',  type: 'gasto' },
  { code: '5299', name: 'Otros gastos',                  type: 'gasto' },
];

/** Crea el catálogo si el negocio todavía no tiene. Idempotente. */
export async function asegurarCatalogo(tenantId: string): Promise<number> {
  const { count } = await db.from('chart_accounts')
    .select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  if (Number(count ?? 0) > 0) return 0;
  const filas = CATALOGO_BASE.map(x => ({
    tenant_id: tenantId, code: x.code, name: x.name, type: x.type,
    postable: x.postable !== false,
  }));
  const { error } = await db.from('chart_accounts').insert(filas);
  if (error) throw new Error(error.message);
  return filas.length;
}

/**
 * GUARDAR UN ASIENTO.
 *
 * Valida, numera y escribe. Devuelve el asiento o lanza con un motivo que se
 * pueda leer: «el asiento no cuadra» sin decir por cuánto obliga a sumar a
 * mano veinte líneas.
 */
export async function crearAsiento(opts: {
  tenantId: string;
  fecha: string;                 // YYYY-MM-DD
  descripcion: string;
  lineas: LineaAsiento[];
  sourceType?: string;
  sourceId?: string;
  userId?: string;
}): Promise<{ id: string; numero: number }> {
  const lineas = opts.lineas
    .map(l => ({ ...l, debe: c2(l.debe ?? 0), haber: c2(l.haber ?? 0) }))
    .filter(l => l.debe > 0 || l.haber > 0);

  if (lineas.length < 2) throw new Error('Un asiento necesita al menos dos líneas.');

  const debe = c2(lineas.reduce((s, l) => s + l.debe, 0));
  const haber = c2(lineas.reduce((s, l) => s + l.haber, 0));
  if (debe !== haber) {
    throw new Error(`El asiento no cuadra: debe ₡${debe.toLocaleString('es-CR')} contra haber `
      + `₡${haber.toLocaleString('es-CR')} (diferencia ₡${c2(Math.abs(debe - haber)).toLocaleString('es-CR')}).`);
  }
  for (const l of lineas) {
    if (l.debe > 0 && l.haber > 0) {
      throw new Error(`La cuenta ${l.code} tiene debe y haber a la vez: eso no es una línea, son dos.`);
    }
  }

  /** Las cuentas tienen que existir y aceptar movimientos. */
  const codigos = [...new Set(lineas.map(l => l.code))];
  const { data: cuentas } = await db.from('chart_accounts')
    .select('code, postable, active').eq('tenant_id', opts.tenantId).in('code', codigos);
  const porCodigo = new Map(((cuentas ?? []) as any[]).map(x => [x.code, x]));
  for (const code of codigos) {
    const cu = porCodigo.get(code);
    if (!cu) throw new Error(`La cuenta ${code} no existe en el catálogo.`);
    if (!cu.postable) throw new Error(`La cuenta ${code} es de agrupación: no acepta movimientos.`);
    if (!cu.active) throw new Error(`La cuenta ${code} está inactiva.`);
  }

  /**
   * El número del asiento.
   *
   * Consecutivo por negocio. Hay una carrera posible si dos asientos se
   * guardan en el mismo instante: el índice único de (tenant, numero) la
   * detecta y se reintenta con el siguiente, que es más simple y más seguro
   * que un contador aparte que se puede desincronizar.
   */
  for (let intento = 0; intento < 5; intento++) {
    const { data: ult } = await db.from('journal_entries')
      .select('numero').eq('tenant_id', opts.tenantId)
      .order('numero', { ascending: false }).limit(1).maybeSingle();
    const numero = Number((ult as any)?.numero ?? 0) + 1 + intento;

    const { data: creado, error } = await db.from('journal_entries').insert({
      tenant_id: opts.tenantId, numero, fecha: opts.fecha,
      descripcion: opts.descripcion,
      source_type: opts.sourceType ?? null, source_id: opts.sourceId ?? null,
      created_by: opts.userId ?? null,
    }).select('id, numero').single();

    if (error) {
      // Ya estaba contabilizado: no es un error, es la protección funcionando.
      if (/journal_source_unico/.test(error.message)) {
        throw new Error('Ese documento ya tiene asiento.');
      }
      if (/numero/.test(error.message) && intento < 4) continue;   // carrera: reintento
      throw new Error(error.message);
    }

    const id = (creado as any).id;
    const { error: errL } = await db.from('journal_lines').insert(
      lineas.map(l => ({
        entry_id: id, tenant_id: opts.tenantId, code: l.code,
        debe: l.debe, haber: l.haber, detalle: l.detalle ?? null,
      })),
    );
    if (errL) {
      // Un asiento sin líneas es basura que descuadra los informes: si las
      // líneas no entran, el encabezado se va con ellas.
      await db.from('journal_entries').delete().eq('id', id);
      throw new Error(errL.message);
    }
    return { id, numero: (creado as any).numero };
  }
  throw new Error('No se pudo numerar el asiento después de varios intentos.');
}

/**
 * ANULAR: se contra-asienta, no se borra.
 *
 * Borrar un asiento deja un hueco en la numeración y hace imposible explicar
 * por qué el balance de ayer no es el de hoy. El contra-asiento deja las dos
 * cosas a la vista.
 */
export async function anularAsiento(tenantId: string, entryId: string, userId?: string) {
  const { data: a } = await db.from('journal_entries')
    .select('*').eq('id', entryId).eq('tenant_id', tenantId).maybeSingle();
  if (!a) throw new Error('Asiento no encontrado');
  if ((a as any).anulado) throw new Error('Ese asiento ya está anulado');

  const { data: lineas } = await db.from('journal_lines').select('*').eq('entry_id', entryId);
  const inv = ((lineas ?? []) as any[]).map(l => ({
    code: l.code, debe: Number(l.haber), haber: Number(l.debe),
    detalle: `Anulación: ${l.detalle ?? ''}`.trim(),
  }));

  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
  const contra = await crearAsiento({
    tenantId, fecha: hoy,
    descripcion: `Anulación del asiento #${(a as any).numero}: ${(a as any).descripcion}`,
    lineas: inv, sourceType: 'anulacion', userId,
  });
  await db.from('journal_entries').update({ anulado: true }).eq('id', entryId);
  await db.from('journal_entries').update({ anula_a: entryId }).eq('id', contra.id);
  return contra;
}
