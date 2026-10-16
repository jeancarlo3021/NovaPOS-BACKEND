import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { respuesta, modoIA } from '../services/ia.js';

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
      return ok(c, respuesta({
        respuesta: ventas.length === 0
          ? `No hay ventas registradas ${etiqueta}.`
          : `${etiqueta.charAt(0).toUpperCase()}${etiqueta.slice(1)} vendiste ${money(total)} en ${ventas.length} factura(s), `
            + `con un promedio de ${money(total / ventas.length)} por venta.`
            + (iva > 0 ? ` IVA incluido: ${money(iva)}.` : ''),
        detalle: detalle || null,
        fuente: `Facturas no anuladas del ${desde} al ${hasta}.`,
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

    // No se reconoció: se dice QUÉ se puede preguntar, en vez de inventar.
    return ok(c, respuesta({
      respuesta: 'Todavía no sé contestar eso. En modo demostración puedo con: '
        + 'cuánto vendiste (hoy, esta semana, este mes, el mes pasado), qué productos dejan más plata, '
        + 'cuánto te deben, cuánto debés y qué productos están por agotarse.',
      detalle: null,
      fuente: null,
      no_entendida: true,
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
      acciones: encontradas.length > 0 ? encontradas : (fallaron.length > 0 ? [{
        titulo: fallaron[0].nombre,
        hacer: [fallaron[0].detalle || 'Volvé a correr el diagnóstico y mandanos el resultado.'],
      }] : []),
      ya_descartado: descartado,
    }));
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default ia;
