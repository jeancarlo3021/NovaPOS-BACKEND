import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * MESA DIGITAL — el QR de la mesa y los avisos del cliente al personal.
 *
 * Dos aplicaciones en un archivo, a propósito:
 *
 *  · `mesaPublic`  — la abre el cliente al escanear el QR. SIN sesión, porque
 *    su razón de ser es que el comensal no tenga que instalar ni registrarse.
 *    Todo lo que hace está atado a un token secreto de UNA mesa.
 *  · `mesaDigital` — el panel del negocio. Va dentro del grupo con `auth`.
 *
 * Lo que el público puede leer está elegido a mano, campo por campo: devolver
 * el negocio entero sería publicarle los datos del dueño a cualquiera que
 * escanee un código pegado en una mesa.
 */

export const mesaPublic = new Hono();
export const mesaDigital = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const TIPOS = ['ordenar', 'mesero', 'cuenta'] as const;
const PAGOS = ['efectivo', 'tarjeta', 'sinpe'] as const;
const ORIGENES = ['qr', 'nfc', 'enlace'] as const;

/** Lo que el negocio configura de la página de la mesa. */
const CONFIG_DEFECTO = {
  activo: true,
  wifi_ssid: '', wifi_password: '',
  whatsapp: '', sinpe_telefono: '', sinpe_nombre: '',
  instagram: '', tiktok: '', google_review: '', maps_url: '',
  direccion: '', horario: '',
  /** Qué botones aparecen: un soda sin wifi no quiere un botón de wifi vacío. */
  ver_mesero: true, ver_cuenta: true, ver_ordenar: true,
  ver_juegos: true, ver_sugerencias: true,
  mensaje: '',
  cantidad_mesas: 0,
};
export type ConfigMesa = typeof CONFIG_DEFECTO;

const leerConfig = async (tenantId: string): Promise<ConfigMesa> => {
  const { data } = await db.from('settings').select('config')
    .eq('tenant_id', tenantId).eq('type', 'mesa-digital').maybeSingle();
  return { ...CONFIG_DEFECTO, ...(((data as any)?.config ?? {}) as Partial<ConfigMesa>) };
};

/**
 * La mesa de un token.
 *
 * El token es la única llave: no se acepta el número de mesa por la dirección.
 * Si no existe, la respuesta es 404 igual que si el negocio no existiera —decir
 * «el código es inválido pero el negocio es este» ya es contar algo.
 */
const mesaDeToken = async (token: string) => {
  if (!/^[A-Za-z0-9]{6,40}$/.test(token)) return null;
  const { data } = await db.from('mesa_tokens')
    .select('tenant_id, numero, nombre').eq('token', token).maybeSingle();
  return (data as any) ?? null;
};

// ═════════════════════════ PÚBLICO (el cliente) ═════════════════════════

/**
 * GET /:token — todo lo que necesita la pantalla de la mesa, en un viaje.
 *
 * Un viaje y no cuatro porque esto se abre con los datos del celular en la
 * mesa de un restaurante, donde la señal es mala: cada petición extra es otra
 * oportunidad de que la pantalla quede a medias.
 */
mesaPublic.get('/:token', async (c) => {
  try {
    const token = String(c.req.param('token') ?? '');
    const mesa = await mesaDeToken(token);
    if (!mesa) return fail(c, 'Mesa no encontrada', 404);

    const tenantId = mesa.tenant_id as string;
    const [negocio, cfg, menu] = await Promise.all([
      db.from('tenants').select('name, status').eq('id', tenantId).maybeSingle(),
      leerConfig(tenantId),
      db.from('digital_menus').select('slug, kind, published, header, config')
        .eq('tenant_id', tenantId).eq('published', true)
        .order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    ]);

    const t: any = (negocio as any)?.data;
    if (!t) return fail(c, 'Mesa no encontrada', 404);
    // Negocio suspendido o módulo apagado: la página no atiende, pero se dice
    // con claridad en vez de dar un error que el cliente no puede interpretar.
    if (!cfg.activo || t.status === 'suspended') {
      return ok(c, { atiende: false, negocio: { nombre: t.name }, mesa: { numero: mesa.numero } });
    }

    const m: any = (menu as any)?.data ?? null;
    const header: any = m?.header ?? {};

    /* La visita se anota sin bloquear la respuesta: si falla, el cliente igual
       tiene que ver su pantalla. */
    const origen = String(c.req.query('origen') ?? 'qr');
    void db.from('mesa_visitas').insert({
      tenant_id: tenantId, numero: mesa.numero,
      origen: (ORIGENES as readonly string[]).includes(origen) ? origen : 'qr',
    }).then(() => undefined, () => undefined);

    return ok(c, {
      atiende: true,
      negocio: {
        nombre: header.title || t.name,
        logo_url: header.logo_url ?? null,
        color: m?.config?.accent ?? null,
      },
      mesa: { numero: mesa.numero, nombre: mesa.nombre ?? null },
      // La carta ya existe en el módulo de menú digital: acá solo se enlaza.
      menu: m ? { slug: m.slug, kind: m.kind ?? 'menu' } : null,
      config: {
        wifi_ssid: cfg.wifi_ssid, wifi_password: cfg.wifi_password,
        whatsapp: cfg.whatsapp,
        sinpe_telefono: cfg.sinpe_telefono, sinpe_nombre: cfg.sinpe_nombre,
        instagram: cfg.instagram, tiktok: cfg.tiktok,
        google_review: cfg.google_review, maps_url: cfg.maps_url,
        direccion: cfg.direccion, horario: cfg.horario,
        ver_mesero: cfg.ver_mesero, ver_cuenta: cfg.ver_cuenta, ver_ordenar: cfg.ver_ordenar,
        ver_juegos: cfg.ver_juegos, ver_sugerencias: cfg.ver_sugerencias,
        mensaje: cfg.mensaje,
      },
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

const LlamadaSchema = z.object({
  tipo: z.enum(TIPOS),
  personas: z.number().int().min(1).max(100).optional().nullable(),
  medio_pago: z.enum(PAGOS).optional().nullable(),
});

/**
 * POST /:token/llamar — el aviso al personal.
 *
 * Si la misma mesa ya tiene un aviso del mismo tipo sin atender, NO se crea
 * otro: se devuelve el que ya estaba. El cliente que toca dos veces porque no
 * vio el mensaje no debe llenarle el panel al mesero de cuatro tarjetas
 * iguales —ahí es cuando el personal empieza a ignorarlas—.
 */
mesaPublic.post('/:token/llamar', async (c) => {
  try {
    const mesa = await mesaDeToken(String(c.req.param('token') ?? ''));
    if (!mesa) return fail(c, 'Mesa no encontrada', 404);

    const parsed = LlamadaSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, 'Pedido inválido', 422);
    const { tipo, personas, medio_pago } = parsed.data;

    const cfg = await leerConfig(mesa.tenant_id);
    if (!cfg.activo) return fail(c, 'La mesa no está atendiendo', 403);
    const permitido = tipo === 'mesero' ? cfg.ver_mesero : tipo === 'cuenta' ? cfg.ver_cuenta : cfg.ver_ordenar;
    if (!permitido) return fail(c, 'Ese aviso está desactivado', 403);

    const { data: yaHay } = await db.from('mesa_llamadas')
      .select('id, created_at').eq('tenant_id', mesa.tenant_id).eq('numero', mesa.numero)
      .eq('tipo', tipo).eq('estado', 'pendiente').limit(1).maybeSingle();
    if (yaHay) return ok(c, { id: (yaHay as any).id, repetido: true });

    const { data, error } = await db.from('mesa_llamadas').insert({
      tenant_id: mesa.tenant_id, numero: mesa.numero, tipo,
      personas: personas ?? null,
      medio_pago: tipo === 'cuenta' ? (medio_pago ?? null) : null,
    }).select('id').single();
    if (error) throw new Error(error.message);
    return ok(c, { id: (data as any).id, repetido: false }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

const SugerenciaSchema = z.object({
  estrellas: z.number().int().min(1).max(5).optional().nullable(),
  mensaje: z.string().trim().min(1).max(1000),
});

mesaPublic.post('/:token/sugerencia', async (c) => {
  try {
    const mesa = await mesaDeToken(String(c.req.param('token') ?? ''));
    if (!mesa) return fail(c, 'Mesa no encontrada', 404);
    const parsed = SugerenciaSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, 'Escribí tu sugerencia', 422);
    const cfg = await leerConfig(mesa.tenant_id);
    if (!cfg.activo || !cfg.ver_sugerencias) return fail(c, 'Las sugerencias están desactivadas', 403);

    const { error } = await db.from('mesa_sugerencias').insert({
      tenant_id: mesa.tenant_id, numero: mesa.numero,
      estrellas: parsed.data.estrellas ?? null, mensaje: parsed.data.mensaje,
    });
    if (error) throw new Error(error.message);
    return ok(c, { enviado: true }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ═════════════════════════ PANEL DEL NEGOCIO ═════════════════════════

mesaDigital.get('/config', async (c) => {
  try {
    const cfg = await leerConfig(c.get('tenantId'));
    const { count } = await db.from('mesa_tokens')
      .select('numero', { count: 'exact', head: true }).eq('tenant_id', c.get('tenantId'));
    return ok(c, { ...cfg, cantidad_mesas: count ?? 0 });
  } catch (err: any) { return fail(c, err.message, 500); }
});

mesaDigital.put('/config', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({}));
    const actual = await leerConfig(tenantId);
    const nueva: any = { ...actual };
    for (const k of Object.keys(CONFIG_DEFECTO) as Array<keyof ConfigMesa>) {
      if (k in body) (nueva as any)[k] = (body as any)[k];
    }
    delete nueva.cantidad_mesas;   // eso lo manda `PUT /mesas`, no la config

    const { error } = await db.from('settings')
      .upsert({ tenant_id: tenantId, type: 'mesa-digital', config: nueva, updated_at: new Date().toISOString() },
        { onConflict: 'tenant_id,type' });
    if (error) throw new Error(error.message);
    return ok(c, nueva);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** Las mesas con su código, para imprimir los QR. */
mesaDigital.get('/mesas', async (c) => {
  try {
    const { data, error } = await db.from('mesa_tokens')
      .select('numero, nombre, token').eq('tenant_id', c.get('tenantId')).order('numero');
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * PUT /mesas — cuántas mesas hay.
 *
 * Crear es seguro, así que se crean las que falten. BAJAR la cantidad borra
 * códigos y deja QR impresos sin servir, así que se exige `confirmar: true`.
 */
mesaDigital.put('/mesas', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({}));
    const cantidad = Math.max(0, Math.min(500, Number(body?.cantidad) || 0));

    const { data: actuales } = await db.from('mesa_tokens')
      .select('numero').eq('tenant_id', tenantId).order('numero');
    const hay = new Set(((actuales as any[]) ?? []).map(r => Number(r.numero)));
    const sobran = [...hay].filter(n => n > cantidad);
    if (sobran.length && body?.confirmar !== true) {
      return fail(c, `Bajar a ${cantidad} mesas borraría el código de ${sobran.length} mesa(s) y sus QR dejarían de servir.`, 409);
    }

    const faltan: Array<{ tenant_id: string; numero: number }> = [];
    for (let n = 1; n <= cantidad; n++) if (!hay.has(n)) faltan.push({ tenant_id: tenantId, numero: n });
    if (faltan.length) {
      const { error } = await db.from('mesa_tokens').insert(faltan);
      if (error) throw new Error(error.message);
    }
    if (sobran.length) {
      const { error } = await db.from('mesa_tokens').delete()
        .eq('tenant_id', tenantId).in('numero', sobran);
      if (error) throw new Error(error.message);
    }
    const { data } = await db.from('mesa_tokens')
      .select('numero, nombre, token').eq('tenant_id', tenantId).order('numero');
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

mesaDigital.put('/mesas/:numero', async (c) => {
  try {
    const numero = Number(c.req.param('numero'));
    const body = await c.req.json().catch(() => ({}));
    const patch: any = {};
    if ('nombre' in body) patch.nombre = String(body.nombre ?? '').slice(0, 60) || null;
    if (!Object.keys(patch).length) return fail(c, 'Nada que cambiar', 422);
    const { error } = await db.from('mesa_tokens').update(patch)
      .eq('tenant_id', c.get('tenantId')).eq('numero', numero);
    if (error) throw new Error(error.message);
    return ok(c, { numero, ...patch });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * POST /mesas/regenerar — cambia el código (una mesa, o todas sin `numero`).
 *
 * Se usa cuando un QR se filtró: alguien le tomó foto al código de la mesa 4 y
 * manda avisos desde la casa. Al regenerarlo, el QR impreso deja de servir.
 */
mesaDigital.post('/mesas/regenerar', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({}));
    const numero = body?.numero != null ? Number(body.numero) : null;

    let q = db.from('mesa_tokens').select('numero').eq('tenant_id', tenantId);
    if (numero != null) q = q.eq('numero', numero);
    const { data: filas } = await q;
    const numeros = ((filas as any[]) ?? []).map(r => Number(r.numero));
    if (!numeros.length) return fail(c, 'No hay mesas para cambiar', 404);

    /* El token lo genera la base (DEFAULT nuevo_token_mesa()), así que se borra
       y se vuelve a insertar: así no hay dos fuentes del mismo secreto. */
    const { error: eDel } = await db.from('mesa_tokens').delete()
      .eq('tenant_id', tenantId).in('numero', numeros);
    if (eDel) throw new Error(eDel.message);
    const { error: eIns } = await db.from('mesa_tokens')
      .insert(numeros.map(n => ({ tenant_id: tenantId, numero: n })));
    if (eIns) throw new Error(eIns.message);

    const { data } = await db.from('mesa_tokens')
      .select('numero, nombre, token').eq('tenant_id', tenantId).order('numero');
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** Las llamadas sin atender, la más vieja primero: es la que más espera. */
mesaDigital.get('/llamadas', async (c) => {
  try {
    const estado = String(c.req.query('estado') ?? 'pendiente');
    let q = db.from('mesa_llamadas')
      .select('id, numero, tipo, personas, medio_pago, estado, created_at, atendida_at')
      .eq('tenant_id', c.get('tenantId'));
    if (estado !== 'todas') q = q.eq('estado', estado);
    const { data, error } = await q.order('created_at', { ascending: estado !== 'atendida' }).limit(200);
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

mesaDigital.patch('/llamadas/:id/atendida', async (c) => {
  try {
    const { error } = await db.from('mesa_llamadas')
      .update({ estado: 'atendida', atendida_at: new Date().toISOString(), atendida_por: c.get('userId') })
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId'));
    if (error) throw new Error(error.message);
    return ok(c, { atendida: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

mesaDigital.get('/sugerencias', async (c) => {
  try {
    const { data, error } = await db.from('mesa_sugerencias')
      .select('id, numero, estrellas, mensaje, created_at')
      .eq('tenant_id', c.get('tenantId')).order('created_at', { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

mesaDigital.delete('/sugerencias/:id', async (c) => {
  try {
    const { error } = await db.from('mesa_sugerencias').delete()
      .eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId'));
    if (error) throw new Error(error.message);
    return ok(c, { borrada: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** Visitas y llamadas de los últimos días, para saber si los QR se usan. */
mesaDigital.get('/resumen', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const dias = Math.max(0, Math.min(90, Number(c.req.query('dias') ?? 7)));
    const desde = new Date(Date.now() - dias * 86_400_000).toISOString();

    const [visitas, llamadas] = await Promise.all([
      db.from('mesa_visitas').select('numero, origen, created_at')
        .eq('tenant_id', tenantId).gte('created_at', desde).limit(5000),
      db.from('mesa_llamadas').select('numero, tipo, estado, created_at, atendida_at')
        .eq('tenant_id', tenantId).gte('created_at', desde).limit(5000),
    ]);

    const lv = ((visitas as any).data ?? []) as any[];
    const ll = ((llamadas as any).data ?? []) as any[];

    /* Cuánto tardó el personal en atender. Es el número que dice si el módulo
       sirve: un aviso que nadie atiende en veinte minutos es peor que nada,
       porque el cliente ya se cansó de esperar creyendo que venían. */
    const atendidas = ll.filter(r => r.estado === 'atendida' && r.atendida_at);
    const minutos = atendidas.map(r =>
      (new Date(r.atendida_at).getTime() - new Date(r.created_at).getTime()) / 60000);
    const promedio = minutos.length
      ? Math.round((minutos.reduce((a, b) => a + b, 0) / minutos.length) * 10) / 10 : null;

    const porMesa: Record<number, { visitas: number; llamadas: number }> = {};
    for (const v of lv) {
      porMesa[v.numero] ??= { visitas: 0, llamadas: 0 };
      porMesa[v.numero].visitas++;
    }
    for (const r of ll) {
      porMesa[r.numero] ??= { visitas: 0, llamadas: 0 };
      porMesa[r.numero].llamadas++;
    }

    return ok(c, {
      dias,
      visitas: lv.length,
      por_origen: {
        qr: lv.filter(v => v.origen === 'qr').length,
        nfc: lv.filter(v => v.origen === 'nfc').length,
        enlace: lv.filter(v => v.origen === 'enlace').length,
      },
      llamadas: ll.length,
      por_tipo: {
        ordenar: ll.filter(r => r.tipo === 'ordenar').length,
        mesero: ll.filter(r => r.tipo === 'mesero').length,
        cuenta: ll.filter(r => r.tipo === 'cuenta').length,
      },
      pendientes: ll.filter(r => r.estado === 'pendiente').length,
      minutos_promedio: promedio,
      por_mesa: porMesa,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default mesaDigital;
