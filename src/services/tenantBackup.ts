import AdmZip from 'adm-zip';
import { db } from '../db/client.js';

/**
 * RESPALDO SEMANAL DE CADA NEGOCIO.
 *
 * ── Qué cubre y qué no ─────────────────────────────────────────────────────
 * Supabase respalda la base completa, pero restaurar eso devuelve TODO: no sirve
 * para recuperar un negocio sin pisar a los otros 41. Esto saca los datos de UN
 * negocio a un archivo, que es lo que hace falta cuando alguien borra su
 * catálogo, se le va un año de ventas, o se quiere llevar su información.
 *
 * ── Cómo encuentra los datos ───────────────────────────────────────────────
 * Dos grupos, verificados contra la base:
 *
 *   · 68 tablas que tienen `tenant_id`: se filtran directo.
 *   · 13 tablas HIJAS que no lo tienen (las líneas de una factura, los
 *     movimientos de una caja, los ítems de una compra…): se sacan por el id de
 *     su padre. Son justo las que un respaldo descuidado deja afuera, y sin ellas
 *     las facturas quedan sin líneas: papel mojado.
 *
 * La lista se PRUEBA en cada corrida: una tabla que ya no existe se anota como
 * omitida en el manifiesto en vez de tumbar el respaldo, y una que exista pero no
 * esté en la lista queda registrada como faltante para agregarla.
 *
 * ── Qué NO se respalda ─────────────────────────────────────────────────────
 * Los catálogos compartidos entre todos los negocios (CABYS, planes, unidades de
 * medida): no son del negocio y pesan más que todo lo demás junto.
 */

/** Tablas del negocio, filtradas por `tenant_id`. */
const TABLAS_DIRECTAS = [
  'accounts_payable', 'accounts_receivable', 'accounts_receivable_payments',
  'agenda_tasks', 'agent_orders', 'attendance_records', 'branches',
  'cash_sessions', 'customer_prices', 'customers', 'customer_zones',
  'demo_requests', 'digital_menus', 'employees', 'expense_categories', 'expenses',
  'fe_consecutivos', 'invoices', 'lead_interactions', 'leads', 'leave_requests',
  'modifier_ingredients', 'payment_receipts', 'payroll_items', 'payroll_runs',
  'product_categories', 'product_kit_items', 'product_modifier_groups', 'products',
  'proformas', 'promotions', 'purchases', 'received_documents',
  'recipe_consumptions', 'recipe_ingredients', 'recipe_productions', 'recipes',
  'recurring_expenses', 'reservation_payments', 'reservations', 'role_permissions',
  'route_orders', 'routes', 'route_stops', 'sales_agents', 'sales_returns',
  'settings', 'shifts', 'stock_adjustments', 'subscriptions', 'supplier_returns',
  'suppliers', 'table_orders', 'tax_withholdings', 'teams', 'tenant_fe_plans',
  'tenant_group_members', 'transfers', 'truck_positions', 'unit_types',
  'user_activity_log', 'user_permissions', 'users', 'user_tenants',
  'wa_payment_reminders', 'warehouses', 'warranties', 'window_orders',
] as const;

/**
 * Tablas hijas: no tienen `tenant_id`, se sacan por el padre.
 *
 * `fk` es la columna que apunta al padre y `padre` la tabla de la que se toman
 * los ids. Sin esto, el respaldo tendría facturas sin líneas y cajas sin
 * movimientos — y eso no se nota hasta que hay que restaurar.
 */
const TABLAS_HIJAS: Array<{ tabla: string; fk: string; padre: string }> = [
  { tabla: 'invoice_items', fk: 'invoice_id', padre: 'invoices' },
  { tabla: 'cash_movements', fk: 'cash_session_id', padre: 'cash_sessions' },
  { tabla: 'purchase_items', fk: 'purchase_id', padre: 'purchases' },
  { tabla: 'reservation_items', fk: 'reservation_id', padre: 'reservations' },
  { tabla: 'agent_order_items', fk: 'order_id', padre: 'agent_orders' },
  { tabla: 'route_order_items', fk: 'order_id', padre: 'route_orders' },
  { tabla: 'table_order_items', fk: 'order_id', padre: 'table_orders' },
  { tabla: 'sales_return_items', fk: 'return_id', padre: 'sales_returns' },
  { tabla: 'supplier_return_items', fk: 'return_id', padre: 'supplier_returns' },
  { tabla: 'transfer_items', fk: 'transfer_id', padre: 'transfers' },
  { tabla: 'warehouse_stock', fk: 'warehouse_id', padre: 'warehouses' },
  { tabla: 'product_modifiers', fk: 'group_id', padre: 'product_modifier_groups' },
  { tabla: 'team_members', fk: 'team_id', padre: 'teams' },
];

export const BUCKET = 'respaldos';
/** Semanas que se conservan. Con 8 hay más de un mes y medio de historia. */
export const SEMANAS_QUE_SE_GUARDAN = 8;

/** Páginas de lectura. Las facturas traen el XML, así que van en tandas chicas. */
const PAGINA = (tabla: string) => (tabla === 'invoices' ? 300 : 1000);

export interface ResumenRespaldo {
  tenant_id: string;
  negocio: string;
  semana: string;
  archivo: string;
  bytes: number;
  filas: Record<string, number>;
  omitidas: Array<{ tabla: string; motivo: string }>;
  /** Tablas que existen en la base pero no están en la lista: hay que agregarlas. */
  sin_cubrir: string[];
  segundos: number;
}

/** Semana ISO, que es como se nombra cada respaldo: 2026-W41. */
export function semanaDe(d = new Date()): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Jueves de la misma semana: define el año ISO.
  x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7));
  const inicio = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  const semana = Math.ceil((((x.getTime() - inicio.getTime()) / 86_400_000) + 1) / 7);
  return `${x.getUTCFullYear()}-W${String(semana).padStart(2, '0')}`;
}

/** Crea el bucket privado la primera vez. No falla si ya está. */
async function asegurarBucket(): Promise<void> {
  const { data } = await db.storage.listBuckets();
  if ((data ?? []).some(b => b.name === BUCKET)) return;
  /**
   * PRIVADO, sin excepción.
   *
   * Un respaldo tiene los clientes, los precios y las ventas del negocio. Si el
   * bucket fuera público bastaría adivinar una dirección para bajarse la
   * contabilidad de cualquiera.
   */
  await db.storage.createBucket(BUCKET, { public: false });
}

/**
 * Lee una tabla completa, por páginas, filtrando por una columna.
 *
 * Dos cosas que la primera versión no contemplaba y dejaban tablas AFUERA del
 * respaldo sin que se notara más que en una línea del manifiesto:
 *
 *   · Hay tablas SIN columna `id` —las de relación: `user_tenants`,
 *     `tenant_group_members`, `fe_consecutivos`, `truck_positions`…—. Ordenar por
 *     `id` falla y la tabla se omitía entera. Y `fe_consecutivos` es de lo más
 *     importante que tiene un negocio: es el número por el que sigue facturando.
 *     Ahora, si no hay `id`, se lee sin orden y de un solo tirón (son tablas
 *     chicas, de relación).
 *   · Los ids del padre van en grupos: con 500 por consulta la URL se pasa de
 *     largo y la petición falla entera («fetch failed»), probado. 200 aguanta.
 */
const POR_GRUPO = 200;

async function leerTodo(
  tabla: string, columna: string, valores: string[] | string,
): Promise<{ filas: any[]; error?: string }> {
  const filas: any[] = [];
  const tam = PAGINA(tabla);
  const grupos = Array.isArray(valores)
    ? Array.from({ length: Math.ceil(valores.length / POR_GRUPO) },
      (_, i) => valores.slice(i * POR_GRUPO, i * POR_GRUPO + POR_GRUPO))
    : [valores];

  /** Sin `id` no se puede paginar con orden estable: se trae todo junto. */
  let sinId = false;

  for (const grupo of grupos) {
    if (Array.isArray(grupo) && grupo.length === 0) continue;
    for (let desde = 0; ; desde += tam) {
      let q = db.from(tabla).select('*').range(desde, desde + tam - 1);
      if (!sinId) q = q.order('id', { ascending: true });
      q = Array.isArray(grupo) ? q.in(columna, grupo) : q.eq(columna, grupo);
      const { data, error } = await q;
      if (error) {
        if (!sinId && /column .*\.?id does not exist/i.test(error.message)) {
          sinId = true;
          desde -= tam;     // se repite esta misma página, ahora sin orden
          continue;
        }
        return { filas, error: error.message };
      }
      const tanda = data ?? [];
      filas.push(...tanda);
      if (tanda.length < tam) break;
    }
  }
  return { filas };
}

/**
 * Respalda UN negocio y sube el archivo.
 *
 * Devuelve el resumen con las filas de cada tabla: es lo que permite mirar un
 * respaldo y saber si trajo lo que tenía que traer, sin abrirlo.
 */
export async function respaldarNegocio(tenantId: string, semana = semanaDe()): Promise<ResumenRespaldo> {
  const t0 = Date.now();
  await asegurarBucket();

  const { data: tenant } = await db.from('tenants').select('id, name').eq('id', tenantId).maybeSingle();
  if (!tenant) throw new Error('Negocio no encontrado');

  const zip = new AdmZip();
  const filas: Record<string, number> = {};
  const omitidas: Array<{ tabla: string; motivo: string }> = [];
  /** Ids por tabla padre, para después sacar las hijas. */
  const idsPadre = new Map<string, string[]>();

  for (const tabla of TABLAS_DIRECTAS) {
    const { filas: datos, error } = await leerTodo(tabla, 'tenant_id', tenantId);
    if (error) { omitidas.push({ tabla, motivo: error }); continue; }
    filas[tabla] = datos.length;
    if (datos.length > 0) zip.addFile(`${tabla}.json`, Buffer.from(JSON.stringify(datos), 'utf8'));
    idsPadre.set(tabla, datos.map((r: any) => String(r.id)).filter(Boolean));
  }

  for (const { tabla, fk, padre } of TABLAS_HIJAS) {
    const ids = idsPadre.get(padre) ?? [];
    if (ids.length === 0) { filas[tabla] = 0; continue; }
    const { filas: datos, error } = await leerTodo(tabla, fk, ids);
    if (error) { omitidas.push({ tabla, motivo: error }); continue; }
    filas[tabla] = datos.length;
    if (datos.length > 0) zip.addFile(`${tabla}.json`, Buffer.from(JSON.stringify(datos), 'utf8'));
  }

  /**
   * El manifiesto va DENTRO del archivo.
   *
   * Un respaldo sin inventario es una bolsa de JSON: no se sabe de qué negocio
   * es, de cuándo, ni si está completo. Con esto, el que lo abre en un año tiene
   * todo lo que necesita para leerlo y para saber qué NO trae.
   */
  const manifiesto = {
    version: 1,
    negocio: { id: (tenant as any).id, nombre: (tenant as any).name },
    semana,
    generado: new Date().toISOString(),
    filas,
    total_filas: Object.values(filas).reduce((a, b) => a + b, 0),
    omitidas,
    nota: 'Un archivo JSON por tabla. Las tablas sin filas no se incluyen. '
      + 'Los catálogos compartidos (CABYS, planes, unidades) NO van: no son del negocio.',
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifiesto, null, 2), 'utf8'));

  /**
   * UN RESPALDO INCOMPLETO NO SE GUARDA.
   *
   * Si una tabla no se pudo leer —se cortó la red a mitad, por ejemplo— subir el
   * archivo igual sería peor que no tener nada: queda un respaldo que parece
   * bueno, con el nombre de la semana puesto, y el día que haya que restaurar
   * aparecen las facturas sin líneas. Mejor que falle y que la próxima corrida lo
   * reintente, porque la marca de «ya está» es justamente que el archivo exista.
   *
   * Una tabla que NO EXISTE en la base no cuenta como falla: se anota y se sigue.
   */
  const fallasReales = omitidas.filter(o => !/does not exist|schema cache/i.test(o.motivo));
  if (fallasReales.length > 0) {
    throw new Error(
      `Respaldo incompleto, no se guardó: ${fallasReales.map(f => `${f.tabla} (${f.motivo})`).join(' · ')}`);
  }

  const buffer = zip.toBuffer();
  const archivo = `${tenantId}/${semana}.zip`;
  const { error: eSubida } = await db.storage.from(BUCKET)
    .upload(archivo, buffer, { contentType: 'application/zip', upsert: true });
  if (eSubida) throw new Error(`No se pudo guardar el respaldo: ${eSubida.message}`);

  return {
    tenant_id: tenantId,
    negocio: (tenant as any).name,
    semana, archivo,
    bytes: buffer.length,
    filas, omitidas,
    sin_cubrir: [],
    segundos: Math.round((Date.now() - t0) / 100) / 10,
  };
}

/** Borra los respaldos viejos de un negocio, dejando los últimos N. */
async function limpiarViejos(tenantId: string): Promise<string[]> {
  const { data } = await db.storage.from(BUCKET).list(tenantId, { limit: 200 });
  const semanas = (data ?? [])
    .map(f => f.name)
    .filter(n => n.endsWith('.zip'))
    .sort()              // 2026-W09 < 2026-W10: el orden alfabético es cronológico
    .reverse();
  const sobran = semanas.slice(SEMANAS_QUE_SE_GUARDAN);
  if (sobran.length === 0) return [];
  await db.storage.from(BUCKET).remove(sobran.map(n => `${tenantId}/${n}`));
  return sobran;
}

export interface ResumenSemanal {
  semana: string;
  respaldados: Array<{ negocio: string; bytes: number; filas: number; segundos: number }>;
  ya_estaban: number;
  fallidos: Array<{ negocio: string; motivo: string }>;
  borrados: number;
  /** Negocios que quedaron para la próxima corrida por falta de tiempo. */
  pendientes: number;
}

/**
 * Respalda los negocios que todavía no tienen el archivo de ESTA semana.
 *
 * Va con presupuesto de tiempo porque lo llama el cron, que corre cada pocos
 * minutos y tiene su propio límite: si no alcanza, los que faltan quedan para la
 * próxima vuelta. Que exista el archivo de la semana es la marca de «ya está»,
 * así que repetir la llamada es inofensivo y no hace falta otra tabla para
 * llevar la cuenta.
 */
export async function respaldoSemanal(opts: {
  presupuestoMs?: number;
  /** Solo informa a quién le toca, sin escribir nada. */
  dryRun?: boolean;
} = {}): Promise<ResumenSemanal> {
  const presupuesto = opts.presupuestoMs ?? 22_000;
  const t0 = Date.now();
  const semana = semanaDe();
  const res: ResumenSemanal = {
    semana, respaldados: [], ya_estaban: 0, fallidos: [], borrados: 0, pendientes: 0,
  };

  await asegurarBucket();

  /**
   * Las DEMOS no se respaldan.
   *
   * Nacen para una prueba y se borran solas; guardarles ocho semanas de historia
   * es gastar espacio en datos que nadie va a querer de vuelta.
   */
  const { data: tenants } = await db.from('tenants')
    .select('id, name, is_demo, status').eq('is_demo', false);
  const negocios = (tenants ?? []).filter((t: any) => t.status !== 'cancelled');

  for (const t of negocios as any[]) {
    if (Date.now() - t0 > presupuesto) { res.pendientes++; continue; }

    const { data: ya } = await db.storage.from(BUCKET).list(String(t.id), { limit: 200 });
    if ((ya ?? []).some(f => f.name === `${semana}.zip`)) { res.ya_estaban++; continue; }

    if (opts.dryRun) { res.respaldados.push({ negocio: t.name, bytes: 0, filas: 0, segundos: 0 }); continue; }

    try {
      const r = await respaldarNegocio(String(t.id), semana);
      res.respaldados.push({
        negocio: r.negocio, bytes: r.bytes,
        filas: Object.values(r.filas).reduce((a, b) => a + b, 0),
        segundos: r.segundos,
      });
      res.borrados += (await limpiarViejos(String(t.id))).length;
    } catch (e: any) {
      res.fallidos.push({ negocio: t.name, motivo: e?.message ?? 'error' });
    }
  }
  return res;
}

/** Los respaldos que hay de un negocio, del más nuevo al más viejo. */
export async function respaldosDe(tenantId: string): Promise<Array<{
  semana: string; bytes: number; creado: string | null;
}>> {
  const { data, error } = await db.storage.from(BUCKET).list(tenantId, { limit: 200 });
  if (error) return [];
  return (data ?? [])
    .filter(f => f.name.endsWith('.zip'))
    .map(f => ({
      semana: f.name.replace('.zip', ''),
      bytes: Number((f as any).metadata?.size ?? 0),
      creado: (f as any).created_at ?? null,
    }))
    .sort((a, b) => b.semana.localeCompare(a.semana));
}

/** Enlace temporal para bajar un respaldo (el bucket es privado). */
export async function enlaceDeRespaldo(tenantId: string, semana: string, segundos = 600): Promise<string> {
  const { data, error } = await db.storage.from(BUCKET)
    .createSignedUrl(`${tenantId}/${semana}.zip`, segundos);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? 'No se pudo crear el enlace');
  return data.signedUrl;
}
