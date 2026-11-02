import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * PORTAL DEL CLIENTE — el enlace que el negocio le manda a su cliente.
 *
 * Dos mitades en un archivo:
 *  · `portalPublico` — lo abre el CLIENTE. Sin sesión: no se va a registrar
 *    para pedir una caja de refrescos. Todo cuelga del token, y del token sale
 *    el cliente: lo que venga del navegador diciendo «soy el cliente tal» se
 *    ignora.
 *  · `portalCliente` — lo usa el NEGOCIO para crear, revocar y configurar.
 *
 * Lo que el cliente ve con precios: los SUYOS. Si tiene precio personalizado
 * por artículo (`customer_prices`), ese manda sobre el de lista; si no, el
 * general. Mostrarle el precio de lista a quien negoció otro es la forma más
 * rápida de perder la venta y la confianza.
 */

export const portalPublico = new Hono();
export const portalCliente = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/** Hora de Costa Rica, en partes. El día del negocio no es el UTC. */
function ahoraCR(): { dia: string; hhmm: string; diaSemana: number } {
  /* `hourCycle: 'h23'` es la forma explícita de pedir 00–23. Con
     `hour12: false` algunos motores devuelven «24» a medianoche, y «24:30»
     es mayor que cualquier hora de corte: el portal se cerraría solo entre
     las 12 y la 1 de la mañana. */
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Costa_Rica', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date());
  const g = (t: string) => f.find(p => p.type === t)?.value ?? '';
  const dias: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dia: `${g('year')}-${g('month')}-${g('day')}`,
    hhmm: `${g('hour')}:${g('minute')}`,
    diaSemana: dias[g('weekday')] ?? 0,
  };
}

export interface ConfigPortal {
  activo: boolean;
  /** Hasta qué hora se reciben pedidos, en hora de Costa Rica. */
  hora_corte: string;            // «16:00»
  /** Días que se atienden. 0 = domingo. */
  dias: number[];
  /** Minutos que el cliente puede seguir cambiando su pedido. 0 = hasta el corte. */
  minutos_para_editar: number;
  /** Texto que ve el cliente cuando está cerrado. */
  mensaje_cerrado: string;
  /** Mostrar las existencias de cada producto. */
  ver_existencias: boolean;
  /** Aviso al cliente cuando el pedido pasa de su límite de crédito. */
  avisar_limite: boolean;
}

const CONFIG_POR_DEFECTO: ConfigPortal = {
  activo: true,
  hora_corte: '16:00',
  dias: [1, 2, 3, 4, 5, 6],
  minutos_para_editar: 0,
  mensaje_cerrado: 'Ya cerramos los pedidos de hoy. Podés dejarlo armado y lo recibimos mañana.',
  ver_existencias: true,
  avisar_limite: true,
};

export async function leerConfigPortal(tenantId: string): Promise<ConfigPortal> {
  try {
    const { data } = await db.from('settings').select('config')
      .eq('tenant_id', tenantId).eq('type', 'portal-cliente').maybeSingle();
    return { ...CONFIG_POR_DEFECTO, ...(((data as any)?.config ?? {}) as Partial<ConfigPortal>) };
  } catch { return CONFIG_POR_DEFECTO; }
}

export interface EstadoCorte {
  abierto: boolean;
  motivo: 'abierto' | 'apagado' | 'dia-no' | 'paso-la-hora';
  /** Minutos que faltan para el corte. null cuando ya cerró. */
  minutos_restantes: number | null;
  hora_corte: string;
}

/**
 * ¿Se pueden recibir pedidos AHORA?
 *
 * Se decide en el servidor y solo en el servidor: la cuenta regresiva de la
 * pantalla es un adorno —basta cambiarle la hora al teléfono para burlarla—.
 */
export function estadoDelCorte(cfg: ConfigPortal): EstadoCorte {
  const { hhmm, diaSemana } = ahoraCR();
  if (!cfg.activo) return { abierto: false, motivo: 'apagado', minutos_restantes: null, hora_corte: cfg.hora_corte };
  if (!cfg.dias.includes(diaSemana)) {
    return { abierto: false, motivo: 'dia-no', minutos_restantes: null, hora_corte: cfg.hora_corte };
  }
  const min = (s: string) => {
    const [h, m] = String(s).split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const faltan = min(cfg.hora_corte) - min(hhmm);
  return faltan > 0
    ? { abierto: true, motivo: 'abierto', minutos_restantes: faltan, hora_corte: cfg.hora_corte }
    : { abierto: false, motivo: 'paso-la-hora', minutos_restantes: null, hora_corte: cfg.hora_corte };
}

/** El enlace a partir del token, con su cliente. null si no sirve. */
async function enlaceDe(token: string) {
  const t = String(token ?? '').trim();
  if (t.length < 20) return null;
  const { data } = await db.from('customer_links')
    .select('*, customers(id, name, commercial_name, phone, email, credit_enabled, credit_limit, is_active)')
    .eq('token', t).maybeSingle();
  if (!data) return null;
  const l = data as any;
  if (l.revocado_el) return null;
  if (l.vence_el && l.vence_el < ahoraCR().dia) return null;
  if (!l.customers || l.customers.is_active === false) return null;
  return l;
}

/** Se anota el uso sin frenar la respuesta: es estadística, no la página. */
function anotarUso(id: string, usos: number) {
  void db.from('customer_links')
    .update({ ultimo_uso: new Date().toISOString(), usos: Number(usos ?? 0) + 1 })
    .eq('id', id).then(() => undefined, () => undefined);
}

// ═════════════════════════ PÚBLICO (el cliente) ═════════════════════════

/**
 * GET /:token — todo lo que necesita la pantalla, en un viaje.
 *
 * Un viaje y no cinco porque esto se abre con los datos del celular, muchas
 * veces desde una bodega o un local con mala señal: cada petición extra es
 * otra oportunidad de que la pantalla quede a medias.
 */
portalPublico.get('/:token', async (c) => {
  try {
    const enlace = await enlaceDe(c.req.param('token'));
    if (!enlace) return fail(c, 'Este enlace ya no sirve. Pedile uno nuevo al negocio.', 404);
    const tenantId = enlace.tenant_id as string;

    const [negocio, cfg] = await Promise.all([
      db.from('tenants').select('name, status').eq('id', tenantId).maybeSingle(),
      leerConfigPortal(tenantId),
    ]);
    const t: any = (negocio as any)?.data;
    if (!t || t.status === 'suspended') {
      return ok(c, { atiende: false, negocio: { nombre: t?.name ?? '' } });
    }

    anotarUso(enlace.id, enlace.usos);
    const cliente = enlace.customers;

    return ok(c, {
      atiende: true,
      negocio: { nombre: t.name },
      cliente: {
        id: cliente.id,
        nombre: cliente.commercial_name || cliente.name,
        telefono: cliente.phone ?? null,
        credito: !!cliente.credit_enabled,
        limite: Number(cliente.credit_limit ?? 0),
      },
      permisos: {
        pedir: !!enlace.puede_pedir,
        ver_saldo: !!enlace.puede_ver_saldo,
        pide_pin: !!enlace.pin,
      },
      corte: estadoDelCorte(cfg),
      config: {
        ver_existencias: cfg.ver_existencias,
        mensaje_cerrado: cfg.mensaje_cerrado,
        minutos_para_editar: cfg.minutos_para_editar,
      },
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * GET /:token/catalogo — los productos CON EL PRECIO DE ESE CLIENTE.
 *
 * El precio personalizado por artículo manda sobre el de lista. Y se arma acá,
 * en el servidor: si el navegador tuviera que calcularlo, bastaría con abrir
 * las herramientas del navegador para pedir al precio que uno quiera.
 */
portalPublico.get('/:token/catalogo', async (c) => {
  try {
    const enlace = await enlaceDe(c.req.param('token'));
    if (!enlace) return fail(c, 'Este enlace ya no sirve.', 404);
    const tenantId = enlace.tenant_id as string;
    const cfg = await leerConfigPortal(tenantId);

    const [{ data: prods }, { data: precios }, { data: cats }] = await Promise.all([
      db.from('products')
        .select('id, name, sku, unit_price, stock_quantity, tracks_stock, category_id, image_url, iva_rate')
        .eq('tenant_id', tenantId).is('deleted_at', null).order('name').limit(2000),
      db.from('customer_prices').select('product_id, price')
        .eq('tenant_id', tenantId).eq('customer_id', enlace.customer_id),
      db.from('product_categories').select('id, name').eq('tenant_id', tenantId).order('name'),
    ]);

    const suyo = new Map<string, number>(
      ((precios ?? []) as any[]).map(p => [String(p.product_id), Number(p.price)]));

    const catalogo = ((prods ?? []) as any[]).map(p => {
      const propio = suyo.get(String(p.id));
      const lista = Number(p.unit_price ?? 0);
      return {
        id: p.id, nombre: p.name, sku: p.sku ?? null,
        categoria_id: p.category_id ?? null,
        imagen: p.image_url ?? null,
        precio: propio != null ? propio : lista,
        /* El de lista viaja SOLO cuando el suyo es menor: así la pantalla puede
           mostrar «tu precio» y se nota el acuerdo. Si fuera mayor, enseñarlo
           sería restregarle que paga de más. */
        precio_lista: propio != null && propio < lista ? lista : null,
        es_precio_propio: propio != null,
        /* Existencias: lo que hay de verdad. Un producto de stock infinito no
           muestra número, porque «999» no significa nada. */
        existencias: cfg.ver_existencias && p.tracks_stock !== false
          ? Math.max(0, Number(p.stock_quantity ?? 0)) : null,
        sin_existencias: p.tracks_stock !== false && Number(p.stock_quantity ?? 0) <= 0,
      };
    });

    return ok(c, {
      categorias: (cats ?? []).map((x: any) => ({ id: x.id, nombre: x.name })),
      productos: catalogo,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** Consecutivo legible, el mismo que usan los pedidos del agente. */
async function proximoNumero(tenantId: string): Promise<string> {
  const { data } = await db.from('agent_orders')
    .select('number').eq('tenant_id', tenantId)
    .order('created_at', { ascending: false }).limit(1);
  const n = parseInt(String((data ?? [])[0]?.number ?? '').replace(/\D/g, ''), 10);
  return `P-${String((Number.isFinite(n) ? n : 0) + 1).padStart(6, '0')}`;
}

const LineaSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().positive().max(100000),
});
const PedidoSchema = z.object({
  items: z.array(LineaSchema).min(1),
  notes: z.string().max(500).optional().nullable(),
});

/**
 * Los precios y las existencias SE VUELVEN A RESOLVER en el servidor.
 *
 * El carrito llega del teléfono y ahí solo se cree la cantidad. El precio sale
 * de la lista del cliente y el nombre del catálogo: así nadie se factura a sí
 * mismo al precio que quiera, y un cambio de precio a mitad de la tarde no
 * entra con el valor viejo.
 */
async function armarLineas(tenantId: string, customerId: string, items: Array<{ product_id: string; quantity: number }>) {
  const ids = [...new Set(items.map(i => i.product_id))];
  const [{ data: prods }, { data: precios }] = await Promise.all([
    db.from('products').select('id, name, unit_price, stock_quantity, tracks_stock')
      .eq('tenant_id', tenantId).is('deleted_at', null).in('id', ids),
    db.from('customer_prices').select('product_id, price')
      .eq('tenant_id', tenantId).eq('customer_id', customerId).in('product_id', ids),
  ]);
  const porId = new Map(((prods ?? []) as any[]).map(p => [String(p.id), p]));
  const suyo = new Map(((precios ?? []) as any[]).map(p => [String(p.product_id), Number(p.price)]));

  const lineas: any[] = [];
  const problemas: string[] = [];
  for (const it of items) {
    const p: any = porId.get(String(it.product_id));
    if (!p) { problemas.push('Un producto del pedido ya no está disponible.'); continue; }
    const qty = Number(it.quantity);
    const hay = Number(p.stock_quantity ?? 0);
    if (p.tracks_stock !== false && qty > hay) {
      problemas.push(hay <= 0
        ? `${p.name}: se agotó.`
        : `${p.name}: solo quedan ${hay}.`);
      continue;
    }
    const precio = suyo.has(String(p.id)) ? Number(suyo.get(String(p.id))) : Number(p.unit_price ?? 0);
    lineas.push({
      product_id: p.id, product_name: p.name,
      quantity: qty, unit_price: precio,
      subtotal: Math.round(precio * qty * 100) / 100,
    });
  }
  const total = Math.round(lineas.reduce((s, l) => s + l.subtotal, 0) * 100) / 100;
  return { lineas, problemas, total };
}

/** Lo que el cliente debe hoy, de las cuentas por cobrar. */
async function saldoDe(tenantId: string, customerId: string) {
  const { data } = await db.from('accounts_receivable')
    .select('id, invoice_number, total_amount, paid_amount, due_date, status, created_at')
    .eq('tenant_id', tenantId).eq('customer_id', customerId)
    .neq('status', 'paid').order('due_date', { ascending: true }).limit(200);
  const hoy = ahoraCR().dia;
  const facturas = ((data ?? []) as any[]).map(f => {
    const saldo = Math.max(0, Number(f.total_amount ?? 0) - Number(f.paid_amount ?? 0));
    return {
      id: f.id, numero: f.invoice_number ?? null,
      total: Number(f.total_amount ?? 0), abonado: Number(f.paid_amount ?? 0),
      saldo, vence: f.due_date ?? null,
      vencida: !!f.due_date && String(f.due_date) < hoy && saldo > 0,
    };
  }).filter(f => f.saldo > 0);
  return {
    facturas,
    total: Math.round(facturas.reduce((s, f) => s + f.saldo, 0)),
    vencido: Math.round(facturas.filter(f => f.vencida).reduce((s, f) => s + f.saldo, 0)),
  };
}

/**
 * POST /:token/pedido — el cliente manda su pedido.
 *
 * Nace en `agent_orders` con `origen='cliente'`, que es la misma bandeja que
 * la caja ya trabaja: se toma, se pasa al POS y se factura con el flujo
 * normal, sea a crédito, en efectivo o por SINPE.
 */
portalPublico.post('/:token/pedido', async (c) => {
  try {
    const enlace = await enlaceDe(c.req.param('token'));
    if (!enlace) return fail(c, 'Este enlace ya no sirve.', 404);
    if (!enlace.puede_pedir) return fail(c, 'Este enlace es solo para consultar la cuenta.', 403);

    const tenantId = enlace.tenant_id as string;
    const cfg = await leerConfigPortal(tenantId);
    const corte = estadoDelCorte(cfg);
    if (!corte.abierto) {
      return fail(c, corte.motivo === 'apagado'
        ? 'El negocio no está recibiendo pedidos por este medio.'
        : cfg.mensaje_cerrado, 409);
    }

    const parsed = PedidoSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, 'El pedido llegó vacío o con datos inválidos.', 422);

    const { lineas, problemas, total } = await armarLineas(tenantId, enlace.customer_id, parsed.data.items);
    if (lineas.length === 0) {
      return fail(c, problemas[0] ?? 'No quedó ninguna línea válida en el pedido.', 409);
    }

    const cliente = enlace.customers;
    /* El crédito se AVISA, no se bloquea: quien decide si le fía es el negocio,
       y la caja ve el saldo antes de facturar. Frenar el pedido acá dejaría al
       cliente sin poder ni pedir, por una deuda que quizá ya pagó hoy. */
    let aviso: string | null = null;
    if (cfg.avisar_limite && cliente.credit_enabled && Number(cliente.credit_limit ?? 0) > 0) {
      const { total: debe } = await saldoDe(tenantId, enlace.customer_id);
      if (debe + total > Number(cliente.credit_limit)) {
        aviso = `Con este pedido pasarías tu límite de crédito (₡${Number(cliente.credit_limit).toLocaleString('es-CR')}). `
          + 'El negocio lo va a revisar antes de despacharlo.';
      }
    }

    const editableHasta = cfg.minutos_para_editar > 0
      ? new Date(Date.now() + cfg.minutos_para_editar * 60_000).toISOString()
      : new Date(Date.now() + (corte.minutos_restantes ?? 0) * 60_000).toISOString();

    const fila = {
      tenant_id: tenantId,
      number: await proximoNumero(tenantId),
      status: 'pending',
      origen: 'cliente',
      customer_link_id: enlace.id,
      customer_id: cliente.id,
      customer_name: cliente.commercial_name || cliente.name,
      customer_phone: cliente.phone ?? null,
      notes: parsed.data.notes?.trim() || null,
      document_type: 'ticket',
      total,
      editable_hasta: editableHasta,
    };
    const { data: pedido, error } = await db.from('agent_orders').insert(fila).select('*').single();
    if (error) throw new Error(error.message);

    const { error: eItems } = await db.from('agent_order_items')
      .insert(lineas.map(l => ({ ...l, order_id: (pedido as any).id })));
    if (eItems) {
      /* Sin líneas no hay pedido: se deshace en vez de dejar un número vacío
         en la bandeja que nadie va a saber qué contenía. */
      await db.from('agent_orders').delete().eq('id', (pedido as any).id);
      throw new Error(eItems.message);
    }

    return ok(c, {
      numero: (pedido as any).number,
      id: (pedido as any).id,
      total,
      editable_hasta: editableHasta,
      problemas,
      aviso,
    }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** GET /:token/pedidos — los suyos, con el estado en palabras. */
portalPublico.get('/:token/pedidos', async (c) => {
  try {
    const enlace = await enlaceDe(c.req.param('token'));
    if (!enlace) return fail(c, 'Este enlace ya no sirve.', 404);
    const { data } = await db.from('agent_orders')
      .select('id, number, status, total, notes, created_at, editable_hasta, reject_reason, invoice_id, agent_order_items(product_id, product_name, quantity, unit_price, subtotal)')
      .eq('tenant_id', enlace.tenant_id).eq('customer_id', enlace.customer_id)
      .order('created_at', { ascending: false }).limit(30);

    const ahora = Date.now();
    /* Los MISMOS estados que usa la bandeja de caja (pending · taken ·
       charged · cancelled), dichos como los entiende el cliente. Inventar acá
       un vocabulario propio dejaría pedidos que no aparecen en ningún filtro
       del negocio. */
    const EN_PALABRAS: Record<string, string> = {
      pending: 'Enviado · esperando al negocio',
      taken: 'Lo está preparando el negocio',
      charged: 'Facturado',
      cancelled: 'Cancelado',
    };
    return ok(c, ((data ?? []) as any[]).map(p => ({
      id: p.id, numero: p.number, total: Number(p.total ?? 0),
      estado: p.status, estado_texto: EN_PALABRAS[p.status] ?? p.status,
      motivo: p.reject_reason ?? null,
      cuando: p.created_at,
      notas: p.notes ?? null,
      /* Se puede tocar solo mientras nadie lo haya tomado Y dentro de la
         ventana: después es de la caja, y cambiarlo por debajo sería mandar a
         despachar una cosa distinta de la que están alistando. */
      editable: p.status === 'pending'
        && (!p.editable_hasta || new Date(p.editable_hasta).getTime() > ahora),
      lineas: (p.agent_order_items ?? []).map((l: any) => ({
        /* El id del producto viaja para que la pantalla pueda VOLVER a armar
           el carrito cuando el cliente toca «Cambiar»: sin él habría que
           adivinar el producto por el nombre. */
        product_id: l.product_id ?? null,
        nombre: l.product_name, cantidad: Number(l.quantity),
        precio: Number(l.unit_price), total: Number(l.subtotal),
      })),
    })));
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** PUT /:token/pedido/:id — cambiar lo pedido, mientras se pueda. */
portalPublico.put('/:token/pedido/:id', async (c) => {
  try {
    const enlace = await enlaceDe(c.req.param('token'));
    if (!enlace) return fail(c, 'Este enlace ya no sirve.', 404);
    const id = c.req.param('id');

    const { data: previo } = await db.from('agent_orders')
      .select('id, status, editable_hasta').eq('id', id)
      .eq('tenant_id', enlace.tenant_id).eq('customer_id', enlace.customer_id).maybeSingle();
    if (!previo) return fail(c, 'Ese pedido no es tuyo o ya no existe.', 404);
    if ((previo as any).status !== 'pending') {
      return fail(c, 'El negocio ya empezó a trabajar este pedido. Llamalos para cambiarlo.', 409);
    }
    const hasta = (previo as any).editable_hasta;
    if (hasta && new Date(hasta).getTime() < Date.now()) {
      return fail(c, 'Se pasó la hora para cambiar este pedido. Llamá al negocio.', 409);
    }

    const parsed = PedidoSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, 'El pedido llegó vacío o con datos inválidos.', 422);

    const { lineas, problemas, total } = await armarLineas(enlace.tenant_id, enlace.customer_id, parsed.data.items);
    if (lineas.length === 0) return fail(c, problemas[0] ?? 'No quedó ninguna línea válida.', 409);

    await db.from('agent_order_items').delete().eq('order_id', id);
    const { error } = await db.from('agent_order_items')
      .insert(lineas.map(l => ({ ...l, order_id: id })));
    if (error) throw new Error(error.message);
    await db.from('agent_orders').update({
      total, notes: parsed.data.notes?.trim() || null, updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', enlace.tenant_id);

    return ok(c, { total, problemas });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** POST /:token/pedido/:id/cancelar — se arrepintió, y está a tiempo. */
portalPublico.post('/:token/pedido/:id/cancelar', async (c) => {
  try {
    const enlace = await enlaceDe(c.req.param('token'));
    if (!enlace) return fail(c, 'Este enlace ya no sirve.', 404);
    const id = c.req.param('id');
    const { data: previo } = await db.from('agent_orders')
      .select('status, editable_hasta').eq('id', id)
      .eq('tenant_id', enlace.tenant_id).eq('customer_id', enlace.customer_id).maybeSingle();
    if (!previo) return fail(c, 'Ese pedido no es tuyo o ya no existe.', 404);
    if ((previo as any).status !== 'pending') {
      return fail(c, 'El negocio ya empezó a trabajarlo. Llamalos para cancelarlo.', 409);
    }
    const hasta = (previo as any).editable_hasta;
    if (hasta && new Date(hasta).getTime() < Date.now()) {
      return fail(c, 'Se pasó la hora para cancelarlo. Llamá al negocio.', 409);
    }
    const { error } = await db.from('agent_orders').update({
      status: 'cancelled', reject_reason: 'Cancelado por el cliente',
      rejected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', enlace.tenant_id);
    if (error) throw new Error(error.message);
    return ok(c, { cancelado: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * GET /:token/cuenta — lo que debe.
 *
 * Con PIN si el negocio lo puso: el enlace se reenvía por WhatsApp y los
 * precios no son secreto, pero lo que se debe no es información para el grupo.
 */
portalPublico.get('/:token/cuenta', async (c) => {
  try {
    const enlace = await enlaceDe(c.req.param('token'));
    if (!enlace) return fail(c, 'Este enlace ya no sirve.', 404);
    if (!enlace.puede_ver_saldo) return fail(c, 'Este enlace no muestra la cuenta.', 403);
    if (enlace.pin && String(c.req.query('pin') ?? '') !== String(enlace.pin)) {
      return fail(c, 'PIN incorrecto', 401);
    }
    const saldo = await saldoDe(enlace.tenant_id, enlace.customer_id);
    return ok(c, {
      ...saldo,
      limite: Number(enlace.customers?.credit_limit ?? 0),
      credito: !!enlace.customers?.credit_enabled,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ═════════════════════════ EL NEGOCIO ═════════════════════════

/**
 * Quién puede crear enlaces y cambiar la configuración.
 *
 * El enlace deja ver precios acordados y lo que el cliente debe. Que lo genere
 * cualquiera —un cajero, un agente de ruta— es regalar la lista de precios del
 * negocio con un toque, y no hay forma de saber después quién lo mandó.
 *
 * Por eso: el dueño y el administrador siempre; cualquier otro rol SOLO si el
 * dueño se lo concedió a mano en Usuarios → Roles, módulo `portal_cliente`.
 *
 * Ojo con la diferencia contra `requirePermission`: ese middleware deja pasar
 * cuando el negocio todavía no configuró ninguna matriz, para no dejar a los
 * empleados sin trabajar el primer día. Acá NO: mientras nadie lo conceda, esto
 * queda en el dueño y el administrador, que era la regla con la que se diseñó.
 */
async function puedeDelPortal(c: any, accion: 'create' | 'edit' | 'delete'): Promise<boolean> {
  let rol = String(c.get('role') ?? '');
  if (['owner', 'admin'].includes(rol)) return true;
  if (!rol) {
    const { data } = await db.from('users').select('role').eq('id', c.get('userId')).maybeSingle();
    rol = String((data as any)?.role ?? '');
    if (['owner', 'admin'].includes(rol)) return true;
  }
  if (!rol) return false;
  const { data } = await db.from('role_permissions')
    .select('can_access, can_create, can_edit, can_delete')
    .eq('tenant_id', c.get('tenantId')).eq('role', rol).eq('module', 'portal_cliente')
    .maybeSingle();
  const fila: any = data;
  return !!fila && fila.can_access === true && fila[`can_${accion}`] === true;
}

/** GET /config · PUT /config — la hora de corte y lo demás. */
portalCliente.get('/config', async (c) => {
  try { return ok(c, await leerConfigPortal(c.get('tenantId'))); }
  catch (err: any) { return fail(c, err.message, 500); }
});

portalCliente.put('/config', async (c) => {
  try {
    if (!(await puedeDelPortal(c, 'edit'))) {
      return fail(c, 'Tu rol no puede cambiar la configuración del portal del cliente.', 403);
    }
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({}));
    const actual = await leerConfigPortal(tenantId);
    const cfg: ConfigPortal = {
      activo: body.activo ?? actual.activo,
      hora_corte: /^\d{2}:\d{2}$/.test(String(body.hora_corte ?? '')) ? body.hora_corte : actual.hora_corte,
      dias: Array.isArray(body.dias) ? body.dias.map(Number).filter((d: number) => d >= 0 && d <= 6) : actual.dias,
      minutos_para_editar: Math.max(0, Math.min(1440, Number(body.minutos_para_editar ?? actual.minutos_para_editar))),
      mensaje_cerrado: String(body.mensaje_cerrado ?? actual.mensaje_cerrado).slice(0, 300),
      ver_existencias: body.ver_existencias ?? actual.ver_existencias,
      avisar_limite: body.avisar_limite ?? actual.avisar_limite,
    };
    const fila = { tenant_id: tenantId, type: 'portal-cliente', config: cfg, updated_at: new Date().toISOString() };
    const { data: previo } = await db.from('settings').select('id')
      .eq('tenant_id', tenantId).eq('type', 'portal-cliente').maybeSingle();
    const r = previo
      ? await db.from('settings').update(fila).eq('id', (previo as any).id)
      : await db.from('settings').insert(fila);
    if (r.error) throw new Error(r.error.message);
    return ok(c, cfg);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** GET /enlaces — los que ya existen, para la pantalla de clientes. */
portalCliente.get('/enlaces', async (c) => {
  try {
    const { data } = await db.from('customer_links')
      .select('id, customer_id, token, puede_pedir, puede_ver_saldo, pin, vence_el, revocado_el, ultimo_uso, usos, created_at')
      .eq('tenant_id', c.get('tenantId')).is('revocado_el', null);
    return ok(c, (data ?? []).map((l: any) => ({ ...l, tiene_pin: !!l.pin, pin: undefined })));
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * POST /enlaces — crea (o regenera) el enlace de UN cliente.
 *
 * Uno por cliente: regenerar reemplaza el token del mismo enlace, y el viejo
 * deja de servir en el acto. Es lo que se hace cuando el enlace se filtró.
 */
portalCliente.post('/enlaces', async (c) => {
  try {
    if (!(await puedeDelPortal(c, 'create'))) {
      return fail(c, 'Tu rol no puede crear el enlace de un cliente.', 403);
    }
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({}));
    const customerId = String(body?.customer_id ?? '');
    if (!customerId) return fail(c, 'Falta el cliente', 422);

    const { data: cli } = await db.from('customers')
      .select('id, name').eq('id', customerId).eq('tenant_id', tenantId).maybeSingle();
    if (!cli) return fail(c, 'Cliente no encontrado', 404);

    const { data: tok } = await db.rpc('nuevo_token_cliente');
    const token = String(tok ?? '').trim()
      || (globalThis.crypto as any).randomUUID().replace(/-/g, '')
         + (globalThis.crypto as any).randomUUID().replace(/-/g, '');

    const fila = {
      tenant_id: tenantId, customer_id: customerId, token,
      puede_pedir: body?.puede_pedir ?? true,
      puede_ver_saldo: body?.puede_ver_saldo ?? true,
      pin: body?.pin ? String(body.pin).replace(/\D/g, '').slice(0, 6) || null : null,
      vence_el: body?.vence_el || null,
      revocado_el: null, created_by: c.get('userId'),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await db.from('customer_links')
      .upsert(fila, { onConflict: 'tenant_id,customer_id' }).select('*').single();
    if (error) throw new Error(error.message);

    try {
      await db.from('user_activity_log').insert({
        tenant_id: tenantId, user_id: c.get('userId'),
        action: 'portal_enlace_creado',
        details: { cliente: (cli as any).name, regenerado: true },
      });
    } catch { /* el registro es deseable, no obligatorio */ }

    return ok(c, { ...(data as any), pin: undefined, tiene_pin: !!fila.pin }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** DELETE /enlaces/:customerId — lo revoca. El enlace deja de abrir. */
portalCliente.delete('/enlaces/:customerId', async (c) => {
  try {
    if (!(await puedeDelPortal(c, 'delete'))) {
      return fail(c, 'Tu rol no puede revocar el enlace de un cliente.', 403);
    }
    const { error } = await db.from('customer_links')
      .update({ revocado_el: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('tenant_id', c.get('tenantId')).eq('customer_id', c.req.param('customerId'));
    if (error) throw new Error(error.message);
    return ok(c, { revocado: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default portalCliente;
