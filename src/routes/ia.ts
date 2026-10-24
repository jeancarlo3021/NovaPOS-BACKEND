import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { respuesta, modoIA, pedirAlModelo } from '../services/ia.js';
import { sugerirCabys } from './cabys.js';
import { planFeatureLabels } from '../services/emailService.js';

/**
 * Las funciones de IA del sistema, hoy en MODO DEMOSTRACIÓN (ver services/ia.ts).
 *
 * Nada de acá llama a un modelo: las respuestas se arman con los datos del
 * propio negocio. Eso tiene una ventaja que no es solo el costo — en una
 * demostración, los números que salen son los de VERDAD del negocio, no un
 * ejemplo inventado, y eso es justo lo que convence a un cliente.
 */
export const ia = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const diaCR = (d: Date | string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });
const money = (n: number) => `₡${Math.round(Number(n) || 0).toLocaleString('es-CR')}`;
/** Cantidades: los decimales de punto flotante no se le muestran a nadie. */
const cant = (n: number) => Number(n || 0).toLocaleString('es-CR', { maximumFractionDigits: 2 });
const norm = (s: string) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ══════════════════════════════════════════════════════════════════════════
// GET /estado — ¿en qué modo está?
// ══════════════════════════════════════════════════════════════════════════
ia.get('/estado', (c) => ok(c, { modo: modoIA() }));

// ══════════════════════════════════════════════════════════════════════════
// PASO 4 — PREGUNTAR EN ESPAÑOL
// ══════════════════════════════════════════════════════════════════════════

/**
 * Qué período pide la pregunta.
 *
 * Sin fecha explícita se asume el mes en curso, que es lo que alguien quiere
 * decir cuando pregunta «¿cómo voy?».
 */
function periodoDe(pregunta: string): { desde: string; hasta: string; etiqueta: string } {
  const p = norm(pregunta);
  const hoyCR = diaCR(new Date());
  const menos = (dias: number) => diaCR(new Date(Date.now() - dias * 86_400_000));
  if (/\bhoy\b/.test(p)) return { desde: hoyCR, hasta: hoyCR, etiqueta: 'hoy' };
  if (/\bayer\b/.test(p)) return { desde: menos(1), hasta: menos(1), etiqueta: 'ayer' };
  if (/semana pasada/.test(p)) return { desde: menos(14), hasta: menos(7), etiqueta: 'la semana pasada' };
  if (/\bsemana\b/.test(p)) return { desde: menos(7), hasta: hoyCR, etiqueta: 'los últimos 7 días' };
  if (/mes pasado/.test(p)) {
    const cr = new Date(Date.now() - 6 * 3_600_000);
    const ini = new Date(Date.UTC(cr.getUTCFullYear(), cr.getUTCMonth() - 1, 1));
    const fin = new Date(Date.UTC(cr.getUTCFullYear(), cr.getUTCMonth(), 0));
    return { desde: diaCR(ini), hasta: diaCR(fin), etiqueta: 'el mes pasado' };
  }
  if (/\baño\b|\banual\b/.test(p)) return { desde: menos(365), hasta: hoyCR, etiqueta: 'los últimos 12 meses' };
  const cr = new Date(Date.now() - 6 * 3_600_000);
  const ini = new Date(Date.UTC(cr.getUTCFullYear(), cr.getUTCMonth(), 1));
  return { desde: diaCR(ini), hasta: hoyCR, etiqueta: 'este mes' };
}

/**
 * El período ANTERIOR del mismo largo.
 *
 * «Vendí ₡800.000 este mes» no dice nada solo: ¿es bueno o malo? La respuesta
 * útil es «₡800.000, 12% más que el mes pasado». Se compara contra un tramo
 * del mismo largo terminando justo antes, no contra «el mes calendario
 * anterior», porque si hoy es 5 comparar 5 días contra 30 da una caída del 80%
 * que no existe y asusta a cualquiera.
 */
function periodoAnterior(desde: string, hasta: string): { desde: string; hasta: string } {
  const d0 = new Date(desde + 'T12:00:00').getTime();
  const d1 = new Date(hasta + 'T12:00:00').getTime();
  const largo = Math.max(86_400_000, d1 - d0 + 86_400_000);
  return { desde: diaCR(new Date(d0 - largo)), hasta: diaCR(new Date(d0 - 86_400_000)) };
}

/** Cómo se dice una variación en castellano, sin falsa precisión. */
function variacion(ahora: number, antes: number): string | null {
  // Devuelve una frase COMPLETA, no un pedazo: antes se anteponía «Es » y
  // salía «Es no hay con qué comparar», que se lee como un error del sistema.
  if (antes <= 0) return ahora > 0 ? 'En el período anterior no hubo ventas, así que no hay con qué comparar.' : null;
  const pct = ((ahora - antes) / antes) * 100;
  if (Math.abs(pct) < 1) return 'Es prácticamente igual que el período anterior.';
  const signo = pct > 0 ? 'más' : 'menos';
  return `Es un ${Math.abs(Math.round(pct))}% ${signo} que el período anterior (${money(antes)}).`;
}

/** Facturas no anuladas del período (paginadas: Supabase corta en 1000). */
async function ventasDe(tenantId: string, desde: string, hasta: string) {
  const filas: any[] = [];
  const desdeISO = `${desde}T00:00:00`;
  const hastaISO = `${hasta}T23:59:59`;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('invoices')
      .select('id, total, subtotal, tax_amount, issued_at, status, payment_method, customer_name')
      .eq('tenant_id', tenantId).neq('status', 'cancelled')
      .gte('issued_at', desdeISO).lte('issued_at', hastaISO)
      .order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    filas.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return filas;
}

/**
 * POST /preguntar  { pregunta }
 *
 * En modo demostración NO interviene ningún modelo: se reconoce de qué habla
 * la pregunta y se contesta con una consulta a la base. Por eso los números
 * son reales y la respuesta dice siempre de dónde salieron: un asistente que
 * tira una cifra sin decir de qué período ni sobre cuántas facturas no sirve
 * para tomar ninguna decisión.
 */
ia.post('/preguntar', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { pregunta } = await c.req.json().catch(() => ({ pregunta: '' }));
    const texto = String(pregunta ?? '').trim();
    if (!texto) return fail(c, 'Escribí una pregunta', 422);

    const p = norm(texto);
    const { desde, hasta, etiqueta } = periodoDe(texto);

    // ── ¿De qué habla? ──
    const esVentas = /vend|venta|factur|ingres|cuanto hice|cuanto llev/.test(p);
    const esProductos = /producto|plato|mas vendido|mejor vend|que se vende/.test(p);
    const esDeudas = /deben|cobrar|pendiente|credito|deuda/.test(p);
    const esPagar = /pagar|proveedor|debo/.test(p);
    // «se está acabando», «se acaba», «por acabarse», «qué hay que reponer»…
    const esStock = /stock|existencia|acab|agotad|repon|minimo|bajo de/.test(p);
    const esClientes = /client|quien me compra|quien compra|mejor comprador/.test(p);
    const esGastos = /gast|egres|compr[eé]|cuanto sali|salida de plata/.test(p);

    if (esVentas && !esProductos) {
      const ventas = await ventasDe(tenantId, desde, hasta);
      const total = ventas.reduce((s, v) => s + Number(v.total || 0), 0);
      const iva = ventas.reduce((s, v) => s + Number(v.tax_amount || 0), 0);
      const porMetodo: Record<string, number> = {};
      for (const v of ventas) {
        const k = String(v.payment_method ?? 'otro');
        porMetodo[k] = (porMetodo[k] ?? 0) + Number(v.total || 0);
      }
      const detalle = Object.entries(porMetodo).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}: ${money(v)}`).join(' · ');

      // La comparación va SIEMPRE, no solo si la preguntan: es lo que
      // convierte una cifra en una noticia.
      const prev = periodoAnterior(desde, hasta);
      let comparacion: string | null = null;
      try {
        const antes = await ventasDe(tenantId, prev.desde, prev.hasta);
        comparacion = variacion(total, antes.reduce((s2, v) => s2 + Number(v.total || 0), 0));
      } catch { /* sin comparación la respuesta sirve igual */ }

      return ok(c, respuesta({
        respuesta: ventas.length === 0
          ? `No hay ventas registradas ${etiqueta}.`
          : `${etiqueta.charAt(0).toUpperCase()}${etiqueta.slice(1)} vendiste ${money(total)} en ${ventas.length} factura(s), `
            + `con un promedio de ${money(total / ventas.length)} por venta.`
            + (comparacion ? ` ${comparacion}` : '')
            + (iva > 0 ? ` IVA incluido: ${money(iva)}.` : ''),
        detalle: detalle || null,
        fuente: `Facturas no anuladas del ${desde} al ${hasta}`
          + (comparacion ? `, comparadas con el ${prev.desde} al ${prev.hasta}` : '') + '.',
      }));
    }

    if (esProductos) {
      const ventas = await ventasDe(tenantId, desde, hasta);
      const ids = ventas.map(v => v.id);
      const porProducto = new Map<string, { nombre: string; cant: number; monto: number }>();
      const lineas: any[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await db.from('invoice_items')
          .select('product_id, product_name, quantity, subtotal').in('invoice_id', ids.slice(i, i + 200));
        lineas.push(...(data ?? []));
      }
      /**
       * El nombre se busca en el PRODUCTO cuando la línea no lo trae.
       *
       * Hay negocios —los de distribución— cuyas líneas se guardan sin
       * `product_name`. Sin esto, todo caía en una bolsa llamada «Sin nombre»
       * y la respuesta al «¿qué me deja más plata?» era un solo renglón
       * inútil, que es exactamente lo que no se puede mostrar en una demo.
       */
      const sinNombre = [...new Set(lineas.filter(l => !l.product_name && l.product_id).map(l => String(l.product_id)))];
      const nombreDe = new Map<string, string>();
      for (let i = 0; i < sinNombre.length; i += 200) {
        const { data } = await db.from('products').select('id, name').in('id', sinNombre.slice(i, i + 200));
        for (const x of (data ?? []) as any[]) nombreDe.set(String(x.id), String(x.name));
      }
      for (const it of lineas) {
        const k = String(it.product_name ?? nombreDe.get(String(it.product_id)) ?? 'Sin nombre');
        const a = porProducto.get(k) ?? { nombre: k, cant: 0, monto: 0 };
        a.cant += Number(it.quantity || 0);
        a.monto += Number(it.subtotal || 0);
        porProducto.set(k, a);
      }
      const top = [...porProducto.values()].sort((a, b) => b.monto - a.monto).slice(0, 5);
      return ok(c, respuesta({
        respuesta: top.length === 0
          ? `No hay ventas ${etiqueta} para comparar productos.`
          : `Lo que más plata dejó ${etiqueta}: ${top.map((t, i) => `${i + 1}) ${t.nombre} (${cant(t.cant)} ${t.cant === 1 ? 'unidad' : 'unidades'}, ${money(t.monto)})`).join(' · ')}.`,
        detalle: null,
        fuente: `Líneas de las facturas del ${desde} al ${hasta}.`,
      }));
    }

    if (esDeudas) {
      const { data } = await db.from('accounts_receivable')
        .select('customer_name, total_amount, paid_amount, due_date, status')
        .eq('tenant_id', tenantId).neq('status', 'paid');
      const pend = (data ?? []).map((r: any) => ({
        cliente: r.customer_name, saldo: Number(r.total_amount || 0) - Number(r.paid_amount || 0),
        vence: r.due_date,
      })).filter(x => x.saldo > 0.5);
      const total = pend.reduce((s, x) => s + x.saldo, 0);
      const hoy = diaCR(new Date());
      const vencidas = pend.filter(x => x.vence && String(x.vence) < hoy);
      const top = [...pend].sort((a, b) => b.saldo - a.saldo).slice(0, 5);
      return ok(c, respuesta({
        respuesta: pend.length === 0
          ? 'Nadie te debe: no hay cuentas por cobrar pendientes.'
          : `Te deben ${money(total)} en ${pend.length} cuenta(s), de las cuales ${vencidas.length} ya venció(eron).`,
        detalle: top.length ? top.map(x => `${x.cliente ?? 'Sin nombre'}: ${money(x.saldo)}`).join(' · ') : null,
        fuente: 'Cuentas por cobrar sin saldar.',
      }));
    }

    if (esPagar) {
      const { data } = await db.from('accounts_payable')
        .select('supplier_name, total_amount, paid_amount, due_date, status')
        .eq('tenant_id', tenantId).neq('status', 'paid');
      const pend = (data ?? []).map((r: any) => ({
        prov: r.supplier_name, saldo: Number(r.total_amount || 0) - Number(r.paid_amount || 0), vence: r.due_date,
      })).filter(x => x.saldo > 0.5);
      const total = pend.reduce((s, x) => s + x.saldo, 0);
      return ok(c, respuesta({
        respuesta: pend.length === 0
          ? 'No tenés cuentas por pagar pendientes registradas.'
          : `Debés ${money(total)} a ${pend.length} proveedor(es).`,
        detalle: pend.slice(0, 5).map(x => `${x.prov ?? 'Sin nombre'}: ${money(x.saldo)}${x.vence ? ` (vence ${x.vence})` : ''}`).join(' · ') || null,
        fuente: 'Cuentas por pagar sin saldar.',
      }));
    }

    if (esClientes) {
      const ventas = await ventasDe(tenantId, desde, hasta);
      const porCliente = new Map<string, { n: number; monto: number }>();
      for (const v of ventas) {
        // Las ventas de mostrador no tienen cliente: agruparlas como «Contado»
        // y no como «Sin nombre» es lo que hace que la respuesta se entienda.
        const k = String(v.customer_name ?? '').trim() || 'Contado (sin cliente)';
        const a = porCliente.get(k) ?? { n: 0, monto: 0 };
        a.n += 1; a.monto += Number(v.total || 0);
        porCliente.set(k, a);
      }
      const top = [...porCliente.entries()].sort((a, b) => b[1].monto - a[1].monto).slice(0, 5);
      const identificados = [...porCliente.entries()].filter(([k]) => !k.startsWith('Contado'));
      return ok(c, respuesta({
        respuesta: top.length === 0
          ? `No hay ventas ${etiqueta} para ver quién compra.`
          : `${etiqueta.charAt(0).toUpperCase()}${etiqueta.slice(1)} te compraron ${porCliente.size} cliente(s) distintos. `
            + `El que más dejó: ${top[0][0]} con ${money(top[0][1].monto)} en ${top[0][1].n} compra(s).`
            + (identificados.length === 0
              ? ' Ojo: ninguna venta tiene cliente asignado, así que no se puede seguir a nadie en el tiempo.'
              : ''),
        detalle: top.map(([k, v]) => `${k}: ${money(v.monto)} (${v.n})`).join(' · '),
        fuente: `Facturas no anuladas del ${desde} al ${hasta}, agrupadas por cliente.`,
      }));
    }

    if (esGastos) {
      /**
       * Gastos del período.
       *
       * Se leen de `expenses` y, si la tabla no existe en esta instalación, la
       * respuesta lo DICE en vez de contestar «₡0»: un cero inventado sobre
       * una tabla que no existe es peor que un «no sé», porque se parece a un
       * dato.
       */
      let filas: any[] | null = null;
      try {
        // Las columnas son `date` y `category_id`, no `expense_date` ni
        // `category`. Lo digo acá porque equivocarse NO daba un error visible:
        // caía en el catch y la respuesta era «el módulo de gastos no está
        // disponible» sobre una tabla que existe y tiene datos. Un «no hay»
        // falso es peor que un error, porque nadie lo va a ir a revisar.
        const { data, error } = await db.from('expenses')
          .select('amount, date, category_id, description')
          .eq('tenant_id', tenantId).gte('date', desde).lte('date', hasta).limit(5000);
        if (error) throw new Error(error.message);
        filas = data ?? [];
      } catch { filas = null; }

      if (filas === null) {
        return ok(c, respuesta({
          respuesta: 'No puedo ver los gastos en este negocio: el módulo de gastos no está disponible.',
          detalle: null, fuente: null,
        }));
      }
      const total = filas.reduce((s2, g) => s2 + Number(g.amount || 0), 0);
      // El nombre de la categoría, no su id: «3f2a-…» no le dice nada a nadie.
      const nombreCat = new Map<string, string>();
      try {
        const { data } = await db.from('expense_categories').select('id, name').eq('tenant_id', tenantId);
        for (const x of (data ?? []) as any[]) nombreCat.set(String(x.id), String(x.name));
      } catch { /* sin nombres se agrupa igual */ }
      const porCat = new Map<string, number>();
      for (const g of filas) {
        const k = nombreCat.get(String(g.category_id)) ?? 'Sin categoría';
        porCat.set(k, (porCat.get(k) ?? 0) + Number(g.amount || 0));
      }
      const top = [...porCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      return ok(c, respuesta({
        respuesta: filas.length === 0
          ? `No hay gastos registrados ${etiqueta}.`
          : `${etiqueta.charAt(0).toUpperCase()}${etiqueta.slice(1)} gastaste ${money(total)} en ${filas.length} registro(s).`,
        detalle: top.map(([k, v]) => `${k}: ${money(v)}`).join(' · ') || null,
        fuente: `Gastos con fecha del ${desde} al ${hasta}.`,
      }));
    }

    if (esStock) {
      const { data } = await db.from('products')
        .select('name, stock_quantity, min_stock_level, tracks_stock')
        .eq('tenant_id', tenantId).is('deleted_at', null).limit(5000);
      const bajos = (data ?? []).filter((p: any) =>
        p.tracks_stock !== false && Number(p.stock_quantity ?? 0) <= Number(p.min_stock_level ?? 0));
      return ok(c, respuesta({
        respuesta: bajos.length === 0
          ? 'Ningún producto está por debajo de su mínimo.'
          : `Hay ${bajos.length} producto(s) en o por debajo del mínimo.`,
        detalle: bajos.slice(0, 8).map((p: any) => `${p.name}: ${p.stock_quantity} (mínimo ${p.min_stock_level})`).join(' · ') || null,
        fuente: 'Inventario actual contra el mínimo de cada producto.',
      }));
    }

    /**
     * No se reconoció la pregunta.
     *
     * En vez de recitar la lista entera de lo que sabe hacer, se busca el tema
     * MÁS CERCANO por palabras compartidas y se ofrece esa pregunta concreta.
     * «¿cuánto entró en caja?» no cae en ninguna regla, pero comparte «caja» y
     * «entró» con ventas: ofrecerle «¿Cuánto vendí este mes?» lo deja a un
     * toque de la respuesta, mientras que una lista de cinco temas lo deja
     * leyendo.
     */
    const TEMAS = [
      { pregunta: '¿Cuánto vendí este mes?',          claves: 'vender ventas facturar ingreso caja entro plata cuanto hice total' },
      { pregunta: '¿Qué producto me deja más plata?', claves: 'producto plato articulo vendido mejor top ranking deja gana' },
      { pregunta: '¿Quién me compra más?',            claves: 'cliente comprador quien compra frecuente fiel' },
      { pregunta: '¿Cuánto me deben?',                claves: 'deben cobrar pendiente credito deuda saldo moroso' },
      { pregunta: '¿Cuánto debo a proveedores?',      claves: 'pagar proveedor debo cuenta pagar' },
      { pregunta: '¿Cuánto gasté este mes?',          claves: 'gasto egreso salida compra pago servicio alquiler' },
      { pregunta: '¿Qué se está acabando?',           claves: 'stock existencia acabar agotar reponer minimo inventario falta' },
    ];
    const tokensPregunta = new Set(norm(texto).split(/[^a-z0-9ñ]+/).filter(w => w.length > 2));
    let mejorTema: { pregunta: string; n: number } | null = null;
    for (const t of TEMAS) {
      const n = t.claves.split(' ').filter(w => tokensPregunta.has(w)).length;
      if (n > 0 && (!mejorTema || n > mejorTema.n)) mejorTema = { pregunta: t.pregunta, n };
    }

    return ok(c, respuesta({
      respuesta: mejorTema
        ? `No estoy seguro de haber entendido. ¿Querías preguntar «${mejorTema.pregunta}»?`
        : 'Todavía no sé contestar eso.',
      detalle: null,
      fuente: null,
      no_entendida: true,
      // La pantalla las muestra como botones: así se contesta de un toque en
      // vez de tener que reescribir la pregunta.
      sugerencias: mejorTema
        ? [mejorTema.pregunta, ...TEMAS.filter(t => t.pregunta !== mejorTema!.pregunta).slice(0, 3).map(t => t.pregunta)]
        : TEMAS.map(t => t.pregunta),
    }));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// PASO 3 — DESCRIPCIONES PARA EL CATÁLOGO / MENÚ DIGITAL
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /descripciones  { ids?: string[], solo_vacias?: boolean }
 *
 * El catálogo digital que se publica con QR muestra nombre y precio, y poco
 * más: casi ningún producto tiene descripción, porque escribir doscientas a
 * mano no lo hace nadie. Esto las propone.
 *
 * En modo demostración se arman con lo que el producto YA tiene —categoría,
 * unidad, marca dentro del nombre— y nunca se inventa un dato que no esté:
 * una descripción que promete «hecho a mano con ingredientes frescos» sobre un
 * tornillo es peor que no tener ninguna, y el que la publica es el negocio.
 *
 * NUNCA se guardan solas: se devuelven como propuesta y la pantalla las aplica
 * si el dueño las acepta.
 */
ia.post('/descripciones', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
    const soloVacias = body?.solo_vacias !== false;

    let q = db.from('products')
      .select('id, name, description, unit_price, category_id, unit_type_id')
      .eq('tenant_id', tenantId).is('deleted_at', null).limit(300);
    if (ids.length > 0) q = q.in('id', ids);
    const { data: prods, error } = await q;
    if (error) throw new Error(error.message);

    const objetivo = (prods ?? []).filter((p: any) =>
      !soloVacias || !String(p.description ?? '').trim());
    if (objetivo.length === 0) return ok(c, respuesta({ propuestas: [] }));

    // Categorías y unidades, para poder decir algo que sea CIERTO.
    const cats = new Map<string, string>();
    const unid = new Map<string, string>();
    try {
      const { data } = await db.from('product_categories').select('id, name').eq('tenant_id', tenantId);
      for (const x of (data ?? []) as any[]) cats.set(String(x.id), String(x.name));
    } catch { /* sin categorías, la descripción sale más corta */ }
    try {
      const { data } = await db.from('unit_types').select('id, name').eq('tenant_id', tenantId);
      for (const x of (data ?? []) as any[]) unid.set(String(x.id), String(x.name));
    } catch { /* idem */ }

    /**
     * Arma la descripción SOLO con datos verificables del producto.
     *
     * El nombre suele traer la presentación («Coca Cola 2.5 L», «Arroz 1 kg»):
     * se reconoce y se dice aparte, que es lo que el cliente quiere saber.
     */
    const describir = (p: any): string => {
      const nombre = String(p.name ?? '').trim();
      const categoria = p.category_id ? cats.get(String(p.category_id)) : null;
      const unidad = p.unit_type_id ? unid.get(String(p.unit_type_id)) : null;
      const presentacion = nombre.match(/(\d+[.,]?\d*)\s*(ml|l|lt|litros?|kg|g|gr|gramos?|oz|un|uds?|unidades?)\b/i);
      const partes: string[] = [];
      if (categoria) partes.push(categoria);
      if (presentacion) partes.push(`presentación de ${presentacion[1]} ${presentacion[2].toLowerCase()}`);
      else if (unidad) partes.push(`se vende por ${unidad.toLowerCase()}`);
      if (partes.length === 0) return '';
      const limpio = partes.join(', ');
      return limpio.charAt(0).toUpperCase() + limpio.slice(1) + '.';
    };

    const propuestas = objetivo.map((p: any) => ({
      id: p.id, name: p.name,
      actual: String(p.description ?? '').trim() || null,
      propuesta: describir(p),
    })).filter(x => x.propuesta);

    return ok(c, respuesta({
      propuestas,
      sin_datos: objetivo.length - propuestas.length,
    }));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// CABYS ASISTIDO
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /cabys  { nombres: string[] }
 *
 * Ponerle código CABYS a un catálogo nuevo es el trabajo más odiado de montar
 * un negocio en facturación electrónica: son trece dígitos por producto,
 * elegidos de un catálogo de veinte mil filas, y equivocarse le cuesta al
 * negocio —no al sistema— frente a Hacienda.
 *
 * ── LA REGLA QUE NO SE NEGOCIA ────────────────────────────────────────────
 * El modelo NUNCA inventa un código. Se le dan los candidatos REALES que
 * salieron del catálogo oficial y de lo que otros negocios ya clasificaron, y
 * lo único que hace es ELEGIR entre ellos y explicar por qué. Un modelo de
 * lenguaje produce trece dígitos con total naturalidad y no hay forma de
 * distinguir a simple vista un código válido de uno inventado: para cuando
 * alguien se da cuenta, ya se facturó. Por eso la elección está acotada por
 * construcción y no por una instrucción en el prompt, que se puede ignorar.
 *
 * En modo demostración contesta igual, con el motivo que arma el buscador. La
 * diferencia con el modelo encendido es la calidad de la elección entre
 * candidatos, no que aparezcan códigos nuevos.
 */
/**
 * ¿Es el dueño del sistema? (su plan trae `admin_dashboard`).
 *
 * Mismo criterio que usa la configuración de FE. Se repite acá en vez de
 * exportarlo para no atar dos rutas por una función de cuatro líneas.
 */
async function esSuperAdmin(userId: string): Promise<boolean> {
  try {
    const { data: u } = await db.from('users').select('tenant_id').eq('id', userId).maybeSingle();
    if (!u?.tenant_id) return false;
    const { data: t } = await db.from('tenants').select('plan_id').eq('id', (u as any).tenant_id).maybeSingle();
    if (!(t as any)?.plan_id) return false;
    const { data: p } = await db.from('subscription_plans').select('features').eq('id', (t as any).plan_id).maybeSingle();
    return ((p as any)?.features)?.admin_dashboard === true;
  } catch { return false; }
}

ia.post('/cabys', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    /*
     * Cada producto puede venir como texto o como { nombre, contexto }.
     *
     * El contexto es el DEPARTAMENTO del archivo que se está importando
     * (LIMPIEZA, FERRETERÍA…). Se usa solo cuando el nombre por sí solo no
     * alcanza para decidir, y es lo que evita que «Guantes de latex» de un
     * negocio de limpieza terminen clasificados como repuesto de motocicleta.
     */
    const crudos: any[] = Array.isArray(body?.nombres) ? body.nombres : (body?.names ?? []);
    const items = crudos
      .map((x: any) => typeof x === 'string'
        ? { nombre: String(x ?? '').trim(), contexto: '' }
        : { nombre: String(x?.nombre ?? x?.name ?? '').trim(), contexto: String(x?.contexto ?? x?.categoria ?? '').trim() })
      .filter((x: any) => x.nombre);
    const nombres: string[] = items.map((x: any) => x.nombre);
    if (nombres.length === 0) return fail(c, 'Mandá al menos un nombre de producto', 422);
    if (nombres.length > 200) return fail(c, 'Máximo 200 productos por consulta', 422);

    const base = await sugerirCabys(items, { alternativas: true });

    /**
     * Los que quedaron flojos son los que valen la pena repasar.
     *
     * Con confianza alta el buscador ya acertó y gastar una llamada al modelo
     * ahí es tirar plata. El valor está en los dudosos y en los que quedaron
     * sin código, que son los que hoy terminan en un «0000000000000» o en una
     * tarde de alguien buscando a mano.
     */
    const dudosos = base.filter((x: any) => !x.code || x.confianza !== 'alta');

    let revisados = 0;
    /**
     * EL MODELO SOLO SE USA EN LA CARGA MASIVA, Y SOLO PARA EL DUEÑO.
     *
     * Cada consulta cuesta. El buscador local sigue atendiendo a todos los
     * negocios sin costo; el modelo entra únicamente cuando el dueño del
     * sistema está importando un catálogo, que es donde hay cientos de
     * productos que clasificar de una vez y donde vale la pena pagarlo.
     *
     * Las dos condiciones se verifican en el SERVIDOR: el `origen` que manda
     * la pantalla no alcanza por sí solo —cualquiera puede mandarlo— y por eso
     * va junto con el permiso del usuario.
     */
    const origen = String(body?.origen ?? '').trim();
    const permiso = {
      motivo: `cabys:${origen || 'sin-origen'}`,
      autorizado: origen === 'importacion' && await esSuperAdmin(c.get('userId')),
    };

    if (modoIA() === 'real' && permiso.autorizado && dudosos.length > 0) {
      /**
       * EN PARALELO Y CON TOPE.
       *
       * Una consulta al modelo tarda un segundo y pico. De a una, un lote con
       * treinta dudosos se pasa de los treinta segundos que aguanta la función
       * en Vercel y el importador recibe un error en vez de las sugerencias
       * que SÍ se resolvieron solas.
       *
       * De a cinco a la vez, treinta dudosos son unos diez segundos. Y el tope
       * de 40 por lote es un freno de mano para el gasto: un archivo con
       * quinientos nombres raros no puede convertirse en quinientas consultas
       * sin que nadie lo haya decidido. Lo que no alcanzó a revisarse queda
       * con su sugerencia local y sus alternativas, que es lo de siempre.
       */
      const A_LA_VEZ = 5;
      const TOPE_POR_LOTE = 40;
      const cola = dudosos.slice(0, TOPE_POR_LOTE);

      const revisarUno = async (item: any) => {
        const candidatos = [
          ...(item.code ? [{ code: item.code, description: item.description }] : []),
          ...((item.alternativas ?? []) as any[]).map(a => ({ code: a.code, description: a.description })),
        ];
        if (candidatos.length < 2) return;
        const elegido = await pedirAlModelo({
          sistema: 'Sos un clasificador de productos para el catálogo CABYS de Costa Rica. '
            + 'Elegí el código que mejor describe el producto ENTRE LOS CANDIDATOS DADOS. '
            + 'Respondé solo con el código elegido y una razón de una línea, separados por «|». '
            + 'Si ninguno sirve, respondé «NINGUNO|» y la razón.',
          mensaje: `Producto: ${item.name}\nCandidatos:\n`
            + candidatos.map(x => `${x.code} — ${x.description}`).join('\n'),
          maxTokens: 120,
          permiso,
        });
        if (!elegido) return;
        const [codigo, razon] = String(elegido).split('|').map(x => x.trim());
        // La defensa real: se acepta únicamente si el código está en la lista
        // que nosotros armamos. Si el modelo devolvió otra cosa, se ignora.
        const valido = candidatos.find(x => x.code === codigo);
        if (!valido) return;
        item.code = valido.code;
        item.description = valido.description;
        item.fuente = 'ia';
        item.motivo = razon || item.motivo;
        revisados += 1;
      };

      for (let i = 0; i < cola.length; i += A_LA_VEZ) {
        await Promise.all(cola.slice(i, i + A_LA_VEZ).map(revisarUno));
      }
    }

    const conCodigo = base.filter((x: any) => x.code).length;
    return ok(c, respuesta({
      sugerencias: base,
      resumen: {
        total: base.length,
        con_codigo: conCodigo,
        sin_codigo: base.length - conCodigo,
        alta: base.filter((x: any) => x.confianza === 'alta').length,
        para_revisar: dudosos.length,
        revisados_por_el_modelo: revisados,
      },
    }));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// TEXTOS PARA LOS ARTÍCULOS DE LA PÁGINA PÚBLICA
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /landing-articulo  { nombre, precio?, publico? }
 *
 * Escribir la ficha de un plan a mano es lo que hace que la página quede a
 * medio llenar: hay que acordarse de TODO lo que incluye, y lo que incluye
 * cambia cada vez que se toca un plan.
 *
 * ── De dónde sale el texto, y por qué eso importa ─────────────────────────
 * De los PLANES REALES del sistema. Se busca el plan por nombre y se listan
 * sus módulos activos con las mismas etiquetas que ya usan los correos
 * (`planFeatureLabels`). O sea: lo que la página promete es exactamente lo
 * que el plan entrega.
 *
 * Un modelo de lenguaje escribiendo esto libremente produciría una lista
 * preciosa con dos funciones que no existen, y eso en una página de precios
 * no es un detalle: es prometerle a un cliente algo que no va a recibir. Por
 * eso los puntos salen de la base y el modelo —cuando se encienda— solo
 * puede redactar la frase de presentación.
 */
ia.post('/landing-articulo', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const nombre = String(body?.nombre ?? '').trim();
    if (!nombre) return fail(c, 'Escribí primero el nombre del plan', 422);

    const { data: planes } = await db.from('subscription_plans')
      .select('name, description, price, features, is_active');

    /**
     * El plan que corresponde, buscándolo con tolerancia.
     *
     * Quien escribe «Básico» en la página se refiere al plan «basico fe con
     * inventario»: exigir el nombre exacto convertiría la ayuda en un «no
     * encontré nada» casi siempre. Se descartan los planes «Demo · <negocio>»,
     * que son de un cliente concreto y no se venden.
     */
    const limpio = (x: any) => norm(String(x ?? ''));
    const n = limpio(nombre);
    const candidatos = ((planes ?? []) as any[])
      .filter(p => !/^demo\s*·/i.test(String(p.name ?? '')));
    const plan = candidatos.find(p => limpio(p.name) === n)
      ?? candidatos.find(p => limpio(p.name).includes(n) || n.includes(limpio(p.name)))
      ?? null;

    if (!plan) {
      return ok(c, respuesta({
        encontrado: false,
        nombres_disponibles: candidatos.map(p => p.name).slice(0, 12),
        aviso_vacio: `No hay ningún plan que se parezca a «${nombre}». Escribí el nombre como está `
          + 'en Planes y volvé a intentar, o llená la ficha a mano.',
      }));
    }

    const incluye = planFeatureLabels(plan.features);
    const precio = Number(plan.price ?? 0);

    /**
     * La frase de presentación.
     *
     * En modo demostración se arma con lo que el plan TIENE, no con adjetivos:
     * «Punto de venta, inventario y facturación electrónica para un negocio
     * con una sucursal». Es menos vistoso que lo que escribiría un modelo y
     * tiene una ventaja que lo compensa: todo lo que dice es verificable.
     */
    const f: any = plan.features ?? {};
    const partes: string[] = [];
    if (f.pos) partes.push('punto de venta');
    if (f.inventory) partes.push('inventario');
    if (f.electronic_invoicing) partes.push('facturación electrónica a Hacienda');
    if (f.reports) partes.push('reportes');
    const cola = f.multi_branch ? 'con varias sucursales'
      : f.hr ? 'con planilla'
      : 'de una sola sucursal';
    const descripcion = partes.length
      ? `${partes.slice(0, -1).join(', ')}${partes.length > 1 ? ' y ' : ''}${partes[partes.length - 1]}`
        .replace(/^./, ch => ch.toUpperCase()) + ` para un negocio ${cola}.`
      : String(plan.description ?? '').trim();

    // Con el modelo encendido se mejora SOLO la redacción. Los puntos de
    // `incluye` nunca pasan por él: son datos, no estilo.
    let descripcionFinal = descripcion;
    if (modoIA() === 'real') {
      const r = await pedirAlModelo({
        sistema: 'Escribís para la página de precios de un sistema de punto de venta en Costa Rica. '
          + 'Reescribí la descripción en UNA frase, en español de Costa Rica, clara y sin adjetivos '
          + 'publicitarios. NO agregues ninguna función que no esté en la lista.',
        mensaje: `Plan: ${plan.name}\nIncluye: ${incluye.join(', ')}\nBorrador: ${descripcion}`,
        maxTokens: 120,
      });
      if (r && r.trim()) descripcionFinal = r.trim();
    }

    return ok(c, respuesta({
      encontrado: true,
      plan: plan.name,
      descripcion: descripcionFinal,
      incluye,
      precio_sugerido: precio > 0
        ? `₡${precio.toLocaleString('es-CR')}/mes`
        : '',
      fuente: `Tomado del plan «${plan.name}» tal como está configurado hoy: `
        + `${incluye.length} módulo(s) activos.`,
    }));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// PASO 5 — SOPORTE: EXPLICAR UN DIAGNÓSTICO EN CRISTIANO
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /explicar-diagnostico  { pasos: [{ nombre, ok, detalle }], contexto? }
 *
 * El diagnóstico de impresión devuelve pasos técnicos. Quien los lee es el
 * cajero, no un técnico: «el puerto 8181 no responde» no le dice qué hacer.
 * Esto lo traduce a una instrucción, en orden, y dice qué NO es el problema —
 * que es lo que evita que alguien pase la tarde detrás del certificado cuando
 * lo que falta es un permiso del navegador.
 */
ia.post('/explicar-diagnostico', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const pasos: Array<{ nombre: string; ok: boolean; detalle?: string }> =
      Array.isArray(body?.pasos) ? body.pasos : [];
    if (pasos.length === 0) return fail(c, 'No hay diagnóstico que explicar', 422);

    const fallaron = pasos.filter(x => !x.ok);
    const texto = (x: any) => `${x.nombre} ${x.detalle ?? ''}`.toLowerCase();

    const reglas: Array<{ busca: RegExp; titulo: string; hacer: string[] }> = [
      {
        busca: /red local|lna|permiso/,
        titulo: 'Chrome está bloqueando el acceso a la red local',
        hacer: [
          'Tocá el candado de la barra de direcciones (o el ⋮ si usás la app instalada).',
          'Entrá a «Configuración del sitio».',
          'Buscá «Dispositivos de la red local» (en inglés, «Apps on this device») y ponelo en Permitir.',
          'Recargá la página y volvé a intentar imprimir.',
        ],
      },
      {
        /**
         * Va ANTES que las demás: cuando aparece este texto, todo lo otro ya
         * pasó y la causa es inequívoca.
         *
         * El orden de los pasos salió de un caso real. Primero se mandaba a
         * probar en incógnito, por las extensiones; el cliente probó y falló
         * igual. Y tiene sentido: el antivirus con filtro web y las políticas
         * del navegador SIGUEN ACTIVOS en incógnito, así que incógnito no
         * descarta nada por sí solo. Ahora primero va la prueba que sí separa
         * las causas —otro navegador—, y lo del incógnito queda al final, que
         * es lo que de verdad aporta.
         */
        busca: /blocked by client|err_blocked|blocked_by/i,
        titulo: 'QZ Tray tiene este sitio en su lista de bloqueados',
        hacer: [
          'Clic derecho en el icono de QZ Tray, junto al reloj → Advanced → Site Manager.',
          'Pestaña «Blocked»: borrá TODO lo que haya ahí con «Delete». No busques «colonclick.com»: QZ guarda certificados, no dominios, y sin certificado la entrada figura como «Untrusted» o «Unsigned» — por eso el bloqueo afecta a Chrome, Edge y Firefox por igual.',
          'En Advanced, desmarcá «Block anonymous requests» si está marcada (sin certificado, nuestras peticiones son anónimas y esa opción las rechaza).',
          'Volvé a tocar «Conectar QZ Tray» y elegí «Allow», marcando «Remember».',
          'Si la lista «Blocked» está vacía y sigue igual: cerrá QZ Tray, borrá la carpeta %APPDATA%\\qz y volvé a abrirlo.',
        ],
      },
      {
        // El navegador cortando el WebSocket es OTRA cosa, y se reconoce solo
        // por el paso del canal de datos. Separarlas importa: el arreglo de una
        // está dentro de QZ Tray y el de la otra en el navegador o el antivirus,
        // y confundirlas fue lo que hizo perder un día de soporte.
        busca: /websocket|canal de datos/i,
        titulo: 'Algo entre el navegador y QZ está cortando la conexión',
        hacer: [
          'Abrí la página en OTRO navegador (Firefox o Edge). Si ahí imprime, el problema es de Chrome; si tampoco, es algo instalado en la computadora.',
          'Antivirus: desactivá un rato la «protección web» o el «filtrado SSL» (Kaspersky, ESET, Avast, Bitdefender cortan este tipo de conexión).',
          'Si la computadora la administra una empresa: abrí chrome://policy y buscá «URLBlocklist»; una regla con ws:// o wss:// lo bloquea todo.',
          'Recién al final, incógnito (Ctrl+Mayús+N): solo descarta extensiones, no el antivirus ni las políticas.',
          'Mientras tanto se puede cobrar con «Imprimir por el navegador», que no usa QZ.',
        ],
      },
      {
        busca: /escuchando|no responde|8181|8282/,
        titulo: 'La impresora no está contestando en esta computadora',
        hacer: [
          'Revisá que QZ Tray esté abierto: tiene que estar el icono junto al reloj.',
          'Si no está, abrilo desde el menú de inicio y esperá unos segundos.',
          'Volvé a correr el diagnóstico.',
        ],
      },
      {
        busca: /llave|certificado|firma/,
        titulo: 'La firma quedó a medias',
        hacer: [
          'Usá el botón «Usar modo comunidad» de esta misma pantalla.',
          'Con los dos campos vacíos, la impresora pide permiso una vez y queda andando.',
          'No hace falta comprar ningún certificado para imprimir.',
        ],
      },
      {
        busca: /app instalada|pwa/,
        titulo: 'Estás en la app instalada',
        hacer: [
          'Abrí el sistema en Chrome normal, una sola vez.',
          'Aceptá ahí los permisos que pida.',
          'Volvé a la app: el permiso queda guardado para el sitio.',
        ],
      },
    ];

    const encontradas = reglas.filter(r => fallaron.some(x => r.busca.test(texto(x))));
    const descartado = pasos.filter(x => x.ok).map(x => x.nombre);

    return ok(c, respuesta({
      resumen: fallaron.length === 0
        ? 'Todo pasó: la impresión está lista para usarse.'
        : `Falló ${fallaron.length} de ${pasos.length} revisiones. Empezá por lo primero de la lista.`,
      // Sin `busca`: la regex es de uso interno y no tiene nada que hacer
      // viajando hasta la pantalla del cajero.
      acciones: encontradas.length > 0 ? encontradas.map(({ titulo, hacer }) => ({ titulo, hacer })) : (fallaron.length > 0 ? [{
        titulo: fallaron[0].nombre,
        hacer: [fallaron[0].detalle || 'Volvé a correr el diagnóstico y mandanos el resultado.'],
      }] : []),
      ya_descartado: descartado,
    }));
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default ia;
