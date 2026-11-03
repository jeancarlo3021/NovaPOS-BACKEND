import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * TALLER 3D — el día del taller: lo que entró, lo que salió y qué se imprime.
 *
 * Tres cosas que en este negocio viven juntas:
 *  · Las VENTAS del día, anotadas a mano. Acá la venta no pasa por la caja: se
 *    cotiza por WhatsApp y se cobra por SINPE, así que lo que hace falta es una
 *    bitácora honesta del día, no una factura por cada llavero.
 *  · Los GASTOS del día, igual: el rollo de filamento, el envío, la luz.
 *  · La COLA DE IMPRESIÓN con su planificador: uno dice cuánto dura la pieza y
 *    el sistema dice en qué máquina entra, cuándo arranca, cuándo termina y
 *    para cuándo se puede prometer la entrega.
 */

export const taller3d = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/** El día de hoy en Costa Rica. El día del taller no es el UTC. */
const hoyCR = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Costa_Rica' }).format(new Date());

/** La fecha (YYYY-MM-DD) y la hora (HH:MM) de un instante, en Costa Rica. */
function enCR(d: Date): { dia: string; hhmm: string; diaSemana: number } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Costa_Rica', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(d);
  const g = (t: string) => f.find(p => p.type === t)?.value ?? '';
  const dias: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dia: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${g('hour')}:${g('minute')}`, diaSemana: dias[g('weekday')] ?? 0 };
}

/** Suma días a una fecha YYYY-MM-DD sin pasar por husos horarios. */
function masDias(dia: string, n: number): string {
  const [y, m, d] = dia.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const diaSemanaDe = (dia: string) => {
  const [y, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

// ═══════════════════════════ Configuración ═══════════════════════════

export interface ConfigTaller {
  /** Horas de enfriado, lijado y empaque antes de que la pieza pueda salir. */
  margen_horas: number;
  /** Lo que sale después de esta hora se entrega al día siguiente. */
  hora_corte_entrega: string;
  /** Días en que se entrega. 0 = domingo. */
  dias_entrega: number[];
}

const CONFIG_POR_DEFECTO: ConfigTaller = {
  margen_horas: 2,
  hora_corte_entrega: '16:00',
  dias_entrega: [1, 2, 3, 4, 5, 6],
};

export async function leerConfigTaller(tenantId: string): Promise<ConfigTaller> {
  try {
    const { data } = await db.from('settings').select('config')
      .eq('tenant_id', tenantId).eq('type', 'taller-3d').maybeSingle();
    return { ...CONFIG_POR_DEFECTO, ...(((data as any)?.config ?? {}) as Partial<ConfigTaller>) };
  } catch { return CONFIG_POR_DEFECTO; }
}

// ═══════════════════════════ EL PLANIFICADOR ═══════════════════════════

export interface TrabajoAPlanificar {
  id: string;
  pieza: string;
  cantidad: number;
  horas: number;
  prioridad: number;
  estado: string;
  impresora_id: string | null;
  fin: string | null;
  fecha_limite: string | null;
  created_at: string;
}

export interface Planificado {
  id: string;
  impresora_id: string;
  inicio: string;
  fin: string;
  entrega_estimada: string;
  /** No llega para la fecha que pidió el cliente. */
  tarde: boolean;
}

/**
 * REPARTE la cola entre las impresoras libres.
 *
 * Es una función pura —recibe los trabajos y las máquinas, devuelve el plan— a
 * propósito: así se puede probar el reparto sin base de datos, que es donde
 * están los errores que de verdad duelen (una pieza prometida para el martes
 * que en realidad sale el jueves).
 *
 * Reglas, y el motivo de cada una:
 *
 *  · Las impresoras trabajan DE CORRIDO, también de noche. Una impresión de 14
 *    horas que arranca a las 6 p. m. termina a las 8 a. m.; partirla por el
 *    horario del local sería inventar una pausa que la máquina no hace.
 *  · Lo que ya está IMPRIMIENDO no se toca: ocupa su máquina hasta que termine.
 *    Parar una pieza a media impresión la arruina, así que ni el trabajo más
 *    urgente se cuela antes.
 *  · Cada trabajo entra en la máquina que se desocupa PRIMERO. Con una sola
 *    impresora esto es una fila; con tres, tres filas que se llenan parejo.
 *  · Orden de la cola: primero los urgentes, luego lo que tiene fecha más
 *    cercana, y al final por orden de llegada. Quien pidió primero no se queda
 *    atrás por casualidad.
 */
export function planificar(
  trabajos: TrabajoAPlanificar[],
  impresoras: Array<{ id: string }>,
  ahora: Date,
  cfg: ConfigTaller,
): Planificado[] {
  if (impresoras.length === 0) return [];

  /* Cuándo queda libre cada máquina. Lo que está imprimiendo ahora la ocupa
     hasta su `fin`; si no se sabe el fin, se asume que ya terminó, que es lo
     único que no bloquea el taller entero. */
  const libre = new Map<string, number>(impresoras.map(m => [m.id, ahora.getTime()]));
  for (const t of trabajos) {
    if (t.estado !== 'imprimiendo' || !t.impresora_id || !libre.has(t.impresora_id)) continue;
    const fin = t.fin ? new Date(t.fin).getTime() : ahora.getTime();
    libre.set(t.impresora_id, Math.max(libre.get(t.impresora_id)!, fin, ahora.getTime()));
  }

  const cola = trabajos
    .filter(t => t.estado === 'en_cola' || t.estado === 'programado')
    .sort((a, b) => {
      if (b.prioridad !== a.prioridad) return b.prioridad - a.prioridad;
      const fa = a.fecha_limite ?? '9999-12-31', fb = b.fecha_limite ?? '9999-12-31';
      if (fa !== fb) return fa < fb ? -1 : 1;
      return String(a.created_at) < String(b.created_at) ? -1 : 1;
    });

  const plan: Planificado[] = [];
  for (const t of cola) {
    // La máquina que se desocupa primero; a igualdad, la de siempre (orden
    // estable), para que replanificar no baraje los trabajos sin motivo.
    let elegida = impresoras[0].id;
    for (const m of impresoras) {
      if (libre.get(m.id)! < libre.get(elegida)!) elegida = m.id;
    }
    const inicio = libre.get(elegida)!;
    const duracionMs = Math.max(0, Number(t.horas) || 0) * Math.max(1, Number(t.cantidad) || 1) * 3_600_000;
    const fin = inicio + duracionMs;
    libre.set(elegida, fin);

    const entrega = diaDeEntrega(new Date(fin), cfg);
    plan.push({
      id: t.id,
      impresora_id: elegida,
      inicio: new Date(inicio).toISOString(),
      fin: new Date(fin).toISOString(),
      entrega_estimada: entrega,
      tarde: !!t.fecha_limite && entrega > t.fecha_limite,
    });
  }
  return plan;
}

/**
 * ¿Para cuándo se puede prometer la pieza?
 *
 * No es el momento en que la máquina termina: hay que dejarla enfriar, quitar
 * soportes y empacar (`margen_horas`). Y lo que queda listo a las once de la
 * noche no sale esa noche: se entrega el siguiente día hábil.
 */
export function diaDeEntrega(fin: Date, cfg: ConfigTaller): string {
  const listo = new Date(fin.getTime() + Math.max(0, cfg.margen_horas) * 3_600_000);
  const { dia, hhmm } = enCR(listo);
  const min = (s: string) => {
    const [h, m] = String(s).split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  let entrega = min(hhmm) <= min(cfg.hora_corte_entrega) ? dia : masDias(dia, 1);
  // Se corre al siguiente día en que el taller entrega. Si no entregan ningún
  // día (configuración imposible), se deja como está en vez de ciclar.
  const dias = cfg.dias_entrega?.length ? cfg.dias_entrega : CONFIG_POR_DEFECTO.dias_entrega;
  for (let i = 0; i < 7 && !dias.includes(diaSemanaDe(entrega)); i++) entrega = masDias(entrega, 1);
  return entrega;
}

// ═══════════════════════════ VENTAS ═══════════════════════════

const ItemSchema = z.object({
  producto_id: z.string().uuid().optional().nullable(),
  descripcion: z.string().min(1).max(300),
  variante: z.string().max(100).optional().nullable(),
  cantidad: z.number().positive().max(100000).default(1),
  precio_unitario: z.number().min(0).max(100_000_000).default(0),
});

/** El total de una venta: las líneas más el envío. En un solo lugar. */
const totalVenta = (lineas: Array<{ cantidad: number; precio_unitario: number }>, envio: number) =>
  Math.round((lineas.reduce((s, l) => s + (Number(l.cantidad) || 0) * (Number(l.precio_unitario) || 0), 0)
    + (Number(envio) || 0)) * 100) / 100;

/**
 * Las líneas de la venta, vengan como vengan.
 *
 * El formulario manda `items`. Pero una venta de UN artículo se puede seguir
 * mandando con los campos sueltos de siempre —así no se rompe lo que ya estaba
 * integrado, ni hay que mandar un arreglo de un elemento para anotar un
 * llavero—. Las dos formas terminan en lo mismo: una lista de líneas.
 */
function lineasDe(v: any): Array<any> {
  if (Array.isArray(v.items) && v.items.length > 0) return v.items;
  return [{
    producto_id: v.producto_id ?? null, descripcion: v.descripcion,
    variante: v.variante ?? null, cantidad: v.cantidad ?? 1,
    precio_unitario: v.precio_unitario ?? 0,
  }];
}

/** «Llavero» · «Llavero y 2 más» — lo que se lee en la lista del día. */
const resumirVenta = (lineas: Array<{ descripcion: string }>) =>
  lineas.length === 1
    ? lineas[0].descripcion
    : `${lineas[0].descripcion} y ${lineas.length - 1} más`;

taller3d.get('/ventas', async (c) => {
  try {
    const fecha = c.req.query('fecha') || hoyCR();
    const hasta = c.req.query('hasta');
    let q = db.from('taller_ventas').select('*').eq('tenant_id', c.get('tenantId'));
    q = hasta ? q.gte('fecha', fecha).lte('fecha', hasta) : q.eq('fecha', fecha);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    /* Las líneas se traen en UNA consulta para todas las ventas del día: una
       por venta serían cincuenta idas y vueltas para pintar una lista. */
    const ventas = (data ?? []) as any[];
    if (ventas.length > 0) {
      const { data: items } = await db.from('taller_venta_items')
        .select('*').in('venta_id', ventas.map(v => v.id)).limit(5000);
      const porVenta = new Map<string, any[]>();
      for (const it of ((items ?? []) as any[])) {
        porVenta.set(String(it.venta_id), [...(porVenta.get(String(it.venta_id)) ?? []), it]);
      }
      for (const v of ventas) v.items = porVenta.get(String(v.id)) ?? [];
    }
    return ok(c, ventas);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.post('/ventas', async (c) => {
  try {
    const p = VentaSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return fail(c, 'Faltan datos de la venta', 422);
    const v = p.data;
    const tenantId = c.get('tenantId');
    const lineas = lineasDe(v).map(l => ({
      producto_id: l.producto_id || null,
      descripcion: String(l.descripcion ?? '').trim(),
      variante: l.variante?.trim() || null,
      cantidad: Number(l.cantidad) || 1,
      precio_unitario: Number(l.precio_unitario) || 0,
      subtotal: Math.round((Number(l.cantidad) || 1) * (Number(l.precio_unitario) || 0) * 100) / 100,
    })).filter(l => l.descripcion);
    if (lineas.length === 0) return fail(c, 'La venta necesita al menos un artículo', 422);

    const total = totalVenta(lineas, v.envio);
    const unaSola = lineas.length === 1 ? lineas[0] : null;
    const { data, error } = await db.from('taller_ventas').insert({
      tenant_id: tenantId, fecha: v.fecha || hoyCR(),
      descripcion: resumirVenta(lineas), cliente: v.cliente?.trim() || null,
      /* Con una sola línea, la cabeza sigue guardando cantidad y precio: hay
         pantallas y reportes viejos que los leen de ahí. Con varias no tendría
         sentido —¿la cantidad de cuál?—, así que queda el total y ya. */
      cantidad: unaSola ? unaSola.cantidad : lineas.reduce((s2, l) => s2 + l.cantidad, 0),
      precio_unitario: unaSola ? unaSola.precio_unitario : 0,
      total, medio_pago: v.medio_pago, categoria: v.categoria,
      producto_id: unaSola?.producto_id ?? null, variante: unaSola?.variante ?? null,
      envio: v.envio, envio_etiqueta: v.envio_etiqueta?.trim() || null,
      notas: v.notas?.trim() || null, created_by: c.get('userId'),
    }).select().single();
    if (error) throw new Error(error.message);

    const { error: eItems } = await db.from('taller_venta_items')
      .insert(lineas.map(l => ({ ...l, tenant_id: tenantId, venta_id: (data as any).id })));
    if (eItems) {
      /* Sin líneas no hay venta: se deshace en vez de dejar un total suelto
         que nadie va a saber de qué era. */
      await db.from('taller_ventas').delete().eq('id', (data as any).id);
      throw new Error(eItems.message);
    }
    return ok(c, { ...(data as any), items: lineas }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.put('/ventas/:id', async (c) => {
  try {
    const p = VentaBase.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return fail(c, 'Datos inválidos', 422);
    const v: any = { ...p.data, updated_at: new Date().toISOString() };
    /* El total se rehace desde las LÍNEAS, no desde la cabeza: con varios
       artículos, cambiar el envío no se puede recalcular con «la cantidad»,
       que ya no significa nada. */
    if (v.cantidad != null || v.precio_unitario != null || v.envio != null) {
      const id = c.req.param('id');
      const [{ data: prev }, { data: items }] = await Promise.all([
        db.from('taller_ventas').select('cantidad, precio_unitario, envio')
          .eq('id', id).eq('tenant_id', c.get('tenantId')).maybeSingle(),
        db.from('taller_venta_items').select('cantidad, precio_unitario').eq('venta_id', id),
      ]);
      const lineas = ((items ?? []) as any[]).length > 0
        ? (items as any[])
        : [{ cantidad: v.cantidad ?? (prev as any)?.cantidad ?? 1,
             precio_unitario: v.precio_unitario ?? (prev as any)?.precio_unitario ?? 0 }];
      v.total = totalVenta(lineas, v.envio ?? (prev as any)?.envio ?? 0);
    }
    const { data, error } = await db.from('taller_ventas').update(v)
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId')).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.delete('/ventas/:id', async (c) => {
  try {
    const { error } = await db.from('taller_ventas').delete()
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId'));
    if (error) throw new Error(error.message);
    return ok(c, { borrado: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

const VentaBase = z.object({
  fecha: z.string().optional(),
  descripcion: z.string().max(300).optional(),
  cliente: z.string().max(200).optional().nullable(),
  cantidad: z.number().positive().max(100000).default(1),
  precio_unitario: z.number().min(0).max(100_000_000).default(0),
  medio_pago: z.enum(['efectivo', 'sinpe', 'tarjeta', 'transferencia', 'otro']).default('efectivo'),
  categoria: z.enum(['impresion', 'diseno', 'material', 'reparacion', 'otro']).default('impresion'),
  /** De qué artículo del catálogo salió, y cuál de sus precios se usó. */
  producto_id: z.string().uuid().optional().nullable(),
  variante: z.string().max(100).optional().nullable(),
  /** El envío se cobra APARTE de la pieza: ver el comentario de la migración. */
  envio: z.number().min(0).max(100_000_000).default(0),
  envio_etiqueta: z.string().max(100).optional().nullable(),
  /** Varios artículos en la misma venta. Si no viene, se usa el de arriba. */
  items: z.array(ItemSchema).max(100).optional(),
  notas: z.string().max(500).optional().nullable(),
});

/* Una venta necesita algo que vender: o la lista de artículos, o el de
   siempre. El `refine` va aparte para que el PUT pueda seguir usando
   `.partial()` —un cambio parcial no tiene por qué traer las líneas—. */
const VentaSchema = VentaBase.refine(
  v => (v.items?.length ?? 0) > 0 || !!v.descripcion?.trim(),
  { message: 'La venta necesita al menos un artículo' },
);

// ═══════════════════════════ GASTOS ═══════════════════════════

const GastoSchema = z.object({
  fecha: z.string().optional(),
  descripcion: z.string().min(1).max(300),
  categoria: z.enum(['filamento', 'resina', 'electricidad', 'repuestos', 'envio', 'otro']).default('filamento'),
  monto: z.number().min(0).max(100_000_000),
  medio_pago: z.enum(['efectivo', 'sinpe', 'tarjeta', 'transferencia', 'otro']).default('efectivo'),
  proveedor: z.string().max(200).optional().nullable(),
  notas: z.string().max(500).optional().nullable(),
});

taller3d.get('/gastos', async (c) => {
  try {
    const fecha = c.req.query('fecha') || hoyCR();
    const hasta = c.req.query('hasta');
    let q = db.from('taller_gastos').select('*').eq('tenant_id', c.get('tenantId'));
    q = hasta ? q.gte('fecha', fecha).lte('fecha', hasta) : q.eq('fecha', fecha);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.post('/gastos', async (c) => {
  try {
    const p = GastoSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return fail(c, 'Faltan datos del gasto', 422);
    const g = p.data;
    const { data, error } = await db.from('taller_gastos').insert({
      tenant_id: c.get('tenantId'), fecha: g.fecha || hoyCR(),
      descripcion: g.descripcion.trim(), categoria: g.categoria, monto: g.monto,
      medio_pago: g.medio_pago, proveedor: g.proveedor?.trim() || null,
      notas: g.notas?.trim() || null, created_by: c.get('userId'),
    }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.put('/gastos/:id', async (c) => {
  try {
    const p = GastoSchema.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return fail(c, 'Datos inválidos', 422);
    const { data, error } = await db.from('taller_gastos')
      .update({ ...p.data, updated_at: new Date().toISOString() })
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId')).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.delete('/gastos/:id', async (c) => {
  try {
    const { error } = await db.from('taller_gastos').delete()
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId'));
    if (error) throw new Error(error.message);
    return ok(c, { borrado: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * GET /resumen — el día en números, ya desglosado.
 *
 * El desglose se arma en el servidor para que la pantalla no tenga que sumar:
 * si el total de arriba y el detalle de abajo los calcula cada uno por su
 * lado, tarde o temprano dejan de coincidir.
 */
taller3d.get('/resumen', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const desde = c.req.query('fecha') || hoyCR();
    const hasta = c.req.query('hasta') || desde;

    const [{ data: ventas }, { data: gastos }] = await Promise.all([
      db.from('taller_ventas').select('*').eq('tenant_id', tenantId).gte('fecha', desde).lte('fecha', hasta),
      db.from('taller_gastos').select('*').eq('tenant_id', tenantId).gte('fecha', desde).lte('fecha', hasta),
    ]);

    /* El corte por artículo sale de las LÍNEAS, no de la cabeza de la venta:
       con varios artículos en una misma venta, la cabeza solo tiene el
       resumen («Llavero y 2 más») y el total. */
    const idsVentas = ((ventas ?? []) as any[]).map(v => v.id);
    const { data: lineas } = idsVentas.length
      ? await db.from('taller_venta_items').select('*').in('venta_id', idsVentas).limit(5000)
      : { data: [] as any[] };

    const sumar = (filas: any[], campo: string, valor: (f: any) => number) => {
      const m: Record<string, { monto: number; cuantos: number }> = {};
      for (const f of filas) {
        const k = String(f[campo] ?? 'otro');
        m[k] ??= { monto: 0, cuantos: 0 };
        m[k].monto += valor(f);
        m[k].cuantos += 1;
      }
      return Object.entries(m)
        .map(([clave, v]) => ({ clave, monto: Math.round(v.monto * 100) / 100, cuantos: v.cuantos }))
        .sort((a, b) => b.monto - a.monto);
    };

    const vs = (ventas ?? []) as any[];
    const gs = (gastos ?? []) as any[];
    const totalVentas = Math.round(vs.reduce((s, v) => s + Number(v.total ?? 0), 0) * 100) / 100;
    /* El envío se cuenta aparte de las piezas: es la respuesta a «¿cuánto
       cobré de envíos?», que no se puede sacar del total mezclado. */
    const totalEnvios = Math.round(vs.reduce((s, v) => s + Number(v.envio ?? 0), 0) * 100) / 100;
    const totalGastos = Math.round(gs.reduce((s, g) => s + Number(g.monto ?? 0), 0) * 100) / 100;

    return ok(c, {
      desde, hasta,
      ventas: {
        total: totalVentas, cuantas: vs.length,
        /** Lo cobrado por las piezas, sin el envío. */
        piezas: Math.round((totalVentas - totalEnvios) * 100) / 100,
        envios: totalEnvios,
        cuantos_envios: vs.filter(v => Number(v.envio ?? 0) > 0).length,
        por_medio: sumar(vs, 'medio_pago', v => Number(v.total ?? 0)),
        por_categoria: sumar(vs, 'categoria', v => Number(v.total ?? 0)),
        /* Por artículo del catálogo: es lo que dice qué se vende de verdad.
           Lo que se escribió a mano cae en «Suelto». */
        por_producto: sumar(
          ((lineas ?? []) as any[]).map(l => ({
            ...l,
            _art: l.producto_id
              ? `${l.descripcion}${l.variante ? ` · ${l.variante}` : ''}`
              : 'Suelto',
          })),
          '_art', l => Number(l.subtotal ?? 0)),
        /** Cuántos artículos se movieron en total (sin contar el envío). */
        articulos: ((lineas ?? []) as any[]).reduce((s2, l) => s2 + Number(l.cantidad ?? 0), 0),
      },
      gastos: {
        total: totalGastos, cuantos: gs.length,
        por_categoria: sumar(gs, 'categoria', g => Number(g.monto ?? 0)),
        por_medio: sumar(gs, 'medio_pago', g => Number(g.monto ?? 0)),
      },
      /* La ganancia del día es lo que entró menos lo que salió. No es la
         utilidad contable —no lleva depreciación ni planilla—, y por eso se
         llama «queda», no «utilidad». */
      queda: Math.round((totalVentas - totalGastos) * 100) / 100,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ═══════════════════════════ CATÁLOGO ═══════════════════════════

const VarianteSchema = z.object({
  nombre: z.string().min(1).max(100),
  precio: z.number().min(0).max(100_000_000),
});

const ArticuloSchema = z.object({
  nombre: z.string().min(1).max(200),
  descripcion: z.string().max(500).optional().nullable(),
  categoria: z.enum(['impresion', 'diseno', 'material', 'reparacion', 'otro']).default('impresion'),
  precio: z.number().min(0).max(100_000_000).default(0),
  /** Los otros precios del MISMO artículo: chico/grande, PLA/resina… */
  variantes: z.array(VarianteSchema).max(20).default([]),
  horas: z.number().min(0).max(500).optional().nullable(),
  material: z.string().max(100).optional().nullable(),
  color: z.string().max(100).optional().nullable(),
  activo: z.boolean().default(true),
});

taller3d.get('/catalogo', async (c) => {
  try {
    let q = db.from('taller_catalogo').select('*').eq('tenant_id', c.get('tenantId'));
    if (c.req.query('todos') !== '1') q = q.eq('activo', true);
    const { data, error } = await q.order('nombre').limit(1000);
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.post('/catalogo', async (c) => {
  try {
    const p = ArticuloSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return fail(c, 'Falta el nombre del artículo', 422);
    const a = p.data;
    const { data, error } = await db.from('taller_catalogo').insert({
      tenant_id: c.get('tenantId'), nombre: a.nombre.trim(),
      descripcion: a.descripcion?.trim() || null, categoria: a.categoria,
      /* Con variantes, el precio de arriba es el de la PRIMERA: así el
         artículo siempre tiene un precio que mostrar, incluso donde no caben
         las variantes (una lista, un total). */
      precio: a.variantes.length > 0 ? a.variantes[0].precio : a.precio,
      variantes: a.variantes,
      horas: a.horas ?? null, material: a.material?.trim() || null,
      color: a.color?.trim() || null, activo: a.activo,
    }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.put('/catalogo/:id', async (c) => {
  try {
    const p = ArticuloSchema.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return fail(c, 'Datos inválidos', 422);
    const a: any = { ...p.data, updated_at: new Date().toISOString() };
    if (Array.isArray(a.variantes) && a.variantes.length > 0) a.precio = a.variantes[0].precio;
    const { data, error } = await db.from('taller_catalogo').update(a)
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId')).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.delete('/catalogo/:id', async (c) => {
  try {
    /* Un artículo ya vendido no se borra: se desactiva. Borrarlo dejaría las
       ventas viejas apuntando a la nada y el desglose por artículo mentiría. */
    const { data: vendido } = await db.from('taller_ventas').select('id')
      .eq('tenant_id', c.get('tenantId')).eq('producto_id', c.req.param('id')).limit(1);
    if ((vendido ?? []).length > 0) {
      const { data, error } = await db.from('taller_catalogo')
        .update({ activo: false, updated_at: new Date().toISOString() })
        .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId')).select().single();
      if (error) throw new Error(error.message);
      return ok(c, { ...(data as any), desactivado: true });
    }
    const { error } = await db.from('taller_catalogo').delete()
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId'));
    if (error) throw new Error(error.message);
    return ok(c, { borrado: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── Tarifas de envío ───────────────────────────────────────────────────────

taller3d.get('/tarifas', async (c) => {
  try {
    const { data, error } = await db.from('taller_envios_tarifas').select('*')
      .eq('tenant_id', c.get('tenantId')).order('monto').limit(100);
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.post('/tarifas', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({}));
    const nombre = String(b?.nombre ?? '').trim();
    if (!nombre) return fail(c, 'La tarifa necesita un nombre', 422);
    const { data, error } = await db.from('taller_envios_tarifas').insert({
      tenant_id: c.get('tenantId'), nombre,
      monto: Math.max(0, Number(b?.monto) || 0), activo: b?.activo ?? true,
    }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.put('/tarifas/:id', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({}));
    const patch: any = { updated_at: new Date().toISOString() };
    if (b?.nombre != null) patch.nombre = String(b.nombre).trim();
    if (b?.monto != null) patch.monto = Math.max(0, Number(b.monto) || 0);
    if (b?.activo != null) patch.activo = !!b.activo;
    const { data, error } = await db.from('taller_envios_tarifas').update(patch)
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId')).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.delete('/tarifas/:id', async (c) => {
  try {
    const { error } = await db.from('taller_envios_tarifas').delete()
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId'));
    if (error) throw new Error(error.message);
    return ok(c, { borrada: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ═══════════════════════════ IMPRESORAS ═══════════════════════════

taller3d.get('/impresoras', async (c) => {
  try {
    const { data, error } = await db.from('impresoras').select('*')
      .eq('tenant_id', c.get('tenantId')).order('nombre');
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.post('/impresoras', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({}));
    const nombre = String(b?.nombre ?? '').trim();
    if (!nombre) return fail(c, 'La impresora necesita un nombre', 422);
    const { data, error } = await db.from('impresoras').insert({
      tenant_id: c.get('tenantId'), nombre,
      notas: String(b?.notas ?? '').trim() || null,
      activa: b?.activa ?? true,
    }).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.put('/impresoras/:id', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({}));
    const patch: any = { updated_at: new Date().toISOString() };
    if (b?.nombre != null) patch.nombre = String(b.nombre).trim();
    if (b?.notas !== undefined) patch.notas = String(b.notas ?? '').trim() || null;
    if (b?.activa != null) patch.activa = !!b.activa;
    const { data, error } = await db.from('impresoras').update(patch)
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId')).select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.delete('/impresoras/:id', async (c) => {
  try {
    /* No se borra una impresora con trabajos encima: se apaga. Borrarla
       dejaría impresiones sin máquina y un calendario que no se entiende. */
    const { data: usada } = await db.from('impresiones').select('id')
      .eq('tenant_id', c.get('tenantId')).eq('impresora_id', c.req.param('id')).limit(1);
    if ((usada ?? []).length > 0) {
      const { data, error } = await db.from('impresoras').update({ activa: false, updated_at: new Date().toISOString() })
        .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId')).select().single();
      if (error) throw new Error(error.message);
      return ok(c, { ...(data as any), apagada: true });
    }
    const { error } = await db.from('impresoras').delete()
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId'));
    if (error) throw new Error(error.message);
    return ok(c, { borrada: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ═══════════════════════════ IMPRESIONES ═══════════════════════════

const ImpresionSchema = z.object({
  pieza: z.string().min(1).max(300),
  /** Si salió del catálogo, de cuál artículo. Las horas se traen de ahí. */
  producto_id: z.string().uuid().optional().nullable(),
  cliente: z.string().max(200).optional().nullable(),
  customer_id: z.string().uuid().optional().nullable(),
  cantidad: z.number().int().positive().max(1000).default(1),
  horas: z.number().positive().max(500),
  material: z.string().max(100).optional().nullable(),
  color: z.string().max(100).optional().nullable(),
  prioridad: z.number().int().min(0).max(1).default(0),
  fecha_limite: z.string().optional().nullable(),
  notas: z.string().max(500).optional().nullable(),
});

taller3d.get('/impresiones', async (c) => {
  try {
    const estado = c.req.query('estado');
    let q = db.from('impresiones').select('*').eq('tenant_id', c.get('tenantId'));
    if (estado && estado !== 'todos') q = q.eq('estado', estado);
    const { data, error } = await q.order('prioridad', { ascending: false }).order('created_at').limit(500);
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.post('/impresiones', async (c) => {
  try {
    const p = ImpresionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return fail(c, 'Falta la pieza o cuánto dura', 422);
    const t = p.data;
    const { data, error } = await db.from('impresiones').insert({
      tenant_id: c.get('tenantId'), pieza: t.pieza.trim(),
      producto_id: t.producto_id || null,
      cliente: t.cliente?.trim() || null, customer_id: t.customer_id || null,
      cantidad: t.cantidad, horas: t.horas,
      material: t.material?.trim() || null, color: t.color?.trim() || null,
      prioridad: t.prioridad, estado: 'en_cola',
      fecha_limite: t.fecha_limite || null, notas: t.notas?.trim() || null,
      created_by: c.get('userId'),
    }).select().single();
    if (error) throw new Error(error.message);
    /* Se replanifica al entrar: el usuario escribe la pieza y ve de una para
       cuándo queda, que es justo lo que vino a averiguar. */
    const plan = await replanificar(c.get('tenantId'));
    const mio = plan.find(x => x.id === (data as any).id) ?? null;
    return ok(c, { ...(data as any), plan: mio }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.put('/impresiones/:id', async (c) => {
  try {
    const p = ImpresionSchema.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return fail(c, 'Datos inválidos', 422);
    const { data, error } = await db.from('impresiones')
      .update({ ...p.data, updated_at: new Date().toISOString() })
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId')).select().single();
    if (error) throw new Error(error.message);
    await replanificar(c.get('tenantId'));
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

const ESTADOS = ['en_cola', 'programado', 'imprimiendo', 'listo', 'entregado', 'cancelado'];

/** POST /impresiones/:id/estado — arrancó, terminó, se entregó, se canceló. */
taller3d.post('/impresiones/:id/estado', async (c) => {
  try {
    const b = await c.req.json().catch(() => ({}));
    const estado = String(b?.estado ?? '');
    if (!ESTADOS.includes(estado)) return fail(c, 'Estado inválido', 422);

    const patch: any = { estado, updated_at: new Date().toISOString() };
    /* Al arrancar de verdad se fija el inicio REAL y se recalcula el fin desde
       ahí: el plan decía «arranca a las 3», pero si arrancó a las 5 todo lo que
       viene detrás se corre dos horas y hay que decirlo. */
    if (estado === 'imprimiendo') {
      const { data: t } = await db.from('impresiones').select('horas, cantidad')
        .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId')).maybeSingle();
      const ahora = new Date();
      patch.inicio = ahora.toISOString();
      patch.fin = new Date(ahora.getTime()
        + (Number((t as any)?.horas ?? 0) * Math.max(1, Number((t as any)?.cantidad ?? 1))) * 3_600_000).toISOString();
    }
    if (estado === 'listo') patch.fin = new Date().toISOString();

    const { data, error } = await db.from('impresiones').update(patch)
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId')).select().single();
    if (error) throw new Error(error.message);
    await replanificar(c.get('tenantId'));
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.delete('/impresiones/:id', async (c) => {
  try {
    const { error } = await db.from('impresiones').delete()
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId'));
    if (error) throw new Error(error.message);
    await replanificar(c.get('tenantId'));
    return ok(c, { borrada: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** Corre el planificador y guarda el resultado. Devuelve el plan. */
async function replanificar(tenantId: string): Promise<Planificado[]> {
  const [{ data: trabajos }, { data: maquinas }, cfg] = await Promise.all([
    db.from('impresiones')
      .select('id, pieza, cantidad, horas, prioridad, estado, impresora_id, fin, fecha_limite, created_at')
      .eq('tenant_id', tenantId).in('estado', ['en_cola', 'programado', 'imprimiendo']).limit(500),
    db.from('impresoras').select('id').eq('tenant_id', tenantId).eq('activa', true).order('created_at'),
    leerConfigTaller(tenantId),
  ]);

  const plan = planificar((trabajos ?? []) as any, (maquinas ?? []) as any, new Date(), cfg);
  for (const p of plan) {
    await db.from('impresiones').update({
      impresora_id: p.impresora_id, inicio: p.inicio, fin: p.fin,
      entrega_estimada: p.entrega_estimada, estado: 'programado',
      updated_at: new Date().toISOString(),
    }).eq('id', p.id).eq('tenant_id', tenantId);
  }
  return plan;
}

/** POST /planificar — rehace el plan a mano (el botón «Replanificar»). */
taller3d.post('/planificar', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data: maquinas } = await db.from('impresoras').select('id').eq('tenant_id', tenantId).eq('activa', true);
    if ((maquinas ?? []).length === 0) {
      return fail(c, 'No hay impresoras activas: agregá al menos una para poder planificar.', 409);
    }
    const plan = await replanificar(tenantId);
    return ok(c, { programados: plan.length, tarde: plan.filter(p => p.tarde).length, plan });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * GET /calendario — lo que hay que hacer, por día.
 *
 * Agrupado por el día en que se PROMETE la entrega, no por el día en que la
 * máquina termina: lo que el taller mira en el calendario es a quién le tiene
 * que responder mañana.
 */
taller3d.get('/calendario', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const desde = c.req.query('desde') || hoyCR();
    const hasta = c.req.query('hasta') || masDias(desde, 30);

    const [{ data: trabajos }, { data: maquinas }] = await Promise.all([
      db.from('impresiones').select('*').eq('tenant_id', tenantId)
        .not('estado', 'in', '("cancelado","entregado")').limit(500),
      db.from('impresoras').select('id, nombre, activa').eq('tenant_id', tenantId),
    ]);
    const nombreMaquina = new Map(((maquinas ?? []) as any[]).map(m => [String(m.id), m.nombre]));

    const dias: Record<string, any[]> = {};
    const sinFecha: any[] = [];
    for (const t of ((trabajos ?? []) as any[])) {
      const fila = { ...t, impresora: t.impresora_id ? nombreMaquina.get(String(t.impresora_id)) ?? null : null,
        tarde: !!t.fecha_limite && !!t.entrega_estimada && t.entrega_estimada > t.fecha_limite };
      const d = t.entrega_estimada;
      if (!d) { sinFecha.push(fila); continue; }
      if (d < desde || d > hasta) continue;
      (dias[d] ??= []).push(fila);
    }
    return ok(c, {
      desde, hasta,
      dias: Object.entries(dias).map(([fecha, items]) => ({ fecha, items })).sort((a, b) => a.fecha < b.fecha ? -1 : 1),
      sin_programar: sinFecha,
      impresoras: maquinas ?? [],
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ═══════════════════════════ CONFIGURACIÓN ═══════════════════════════

taller3d.get('/config', async (c) => {
  try { return ok(c, await leerConfigTaller(c.get('tenantId'))); }
  catch (err: any) { return fail(c, err.message, 500); }
});

taller3d.put('/config', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const b = await c.req.json().catch(() => ({}));
    const actual = await leerConfigTaller(tenantId);
    const cfg: ConfigTaller = {
      margen_horas: Math.max(0, Math.min(72, Number(b?.margen_horas ?? actual.margen_horas))),
      hora_corte_entrega: /^\d{2}:\d{2}$/.test(String(b?.hora_corte_entrega ?? '')) ? b.hora_corte_entrega : actual.hora_corte_entrega,
      dias_entrega: Array.isArray(b?.dias_entrega)
        ? b.dias_entrega.map(Number).filter((d: number) => d >= 0 && d <= 6) : actual.dias_entrega,
    };
    const fila = { tenant_id: tenantId, type: 'taller-3d', config: cfg, updated_at: new Date().toISOString() };
    const { data: previo } = await db.from('settings').select('id')
      .eq('tenant_id', tenantId).eq('type', 'taller-3d').maybeSingle();
    const r = previo
      ? await db.from('settings').update(fila).eq('id', (previo as any).id)
      : await db.from('settings').insert(fila);
    if (r.error) throw new Error(r.error.message);
    await replanificar(tenantId);
    return ok(c, cfg);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default taller3d;
