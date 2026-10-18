import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * Menú digital con QR.
 *
 * Dos superficies muy distintas que comparten una tabla:
 *
 *  · `digitalMenu`  — con sesión. El negocio arma su menú.
 *  · `publicMenu`   — SIN sesión. Lo que el cliente abre desde la mesa.
 *
 * Están separadas a propósito y no por un flag interno: la ruta pública no puede
 * heredar por accidente nada que dependa del usuario. Todo lo que devuelve está
 * elegido a mano —lo que el negocio decidió publicar y nada más—, porque acá un
 * `select('*')` de más es una filtración de costos y márgenes a cualquiera que
 * escanee el código.
 */

// ══════════════════════════════════════════════════════════════════════════
// EDITOR (con sesión)
// ══════════════════════════════════════════════════════════════════════════

export const digitalMenu = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/**
 * QUÉ PÁGINA ES: carta de restaurante o vitrina de productos.
 *
 * Son la misma mecánica —secciones, temas, publicar, QR, visitas— con dos
 * contenidos distintos: la carta muestra alérgenos y dietas del plato; el
 * catálogo, el código del producto y si hay existencias. Comparten tabla
 * (columna `kind`) y comparten código a propósito: duplicar el módulo para
 * cambiar las etiquetas garantiza que dentro de un año uno tenga los arreglos
 * y el otro no.
 *
 * Un negocio puede tener los dos: un restaurante que además vende sus salsas.
 */
export type TipoPagina = 'menu' | 'catalogo';

const esCatalogo = (k: any): boolean => String(k ?? '').toLowerCase() === 'catalogo';
/** El tipo pedido, con 'menu' como valor por omisión (lo que ya existía). */
const tipoDe = (c: any): TipoPagina => esCatalogo(c.req.query('kind')) ? 'catalogo' : 'menu';

// ══════════════════════════════════════════════════════════════════════════
// PROMOCIONES EN LA PÁGINA PÚBLICA
// ══════════════════════════════════════════════════════════════════════════

/**
 * Hoy en hora de Costa Rica.
 *
 * No en UTC: a las 7 de la noche de acá ya es el día siguiente en UTC, y una
 * promo que vence hoy desaparecería de la carta media tarde antes de hora —
 * justo en la hora de más visitas.
 */
const hoyCR = (): string =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });

/**
 * La etiqueta que lee el cliente. Es el mismo texto que usa el POS
 * (`promoLabel` en services/promotions/promotionsService.ts), a propósito: si
 * la vitrina dice «20% desc.» y el tiquete dice otra cosa, la discusión es en
 * la caja y la pierde el negocio.
 */
function etiquetaPromo(p: any): string {
  const n = (v: any) => Number(v ?? 0).toLocaleString('es-CR');
  if (p.type === 'percentage') return `${p.value}% desc.`;
  if (p.type === 'fixed')      return `-¢${n(p.value)}`;
  if (p.type === '2x1')        return '2×1';
  if (p.type === 'qty_bundle') return `${n(p.bundle_qty)} × ¢${n(p.value)}`;
  if (p.type === 'combo')      return p.combo_mode === 'percent' ? `Combo -${p.value}%` : `Combo ¢${n(p.value)}`;
  return '';
}

/**
 * Cuál promo le toca a un producto.
 *
 * Copia exacta de la precedencia del POS (`getProductPromotion`): primero la
 * que nombra al producto, después la de su categoría, y de último la general.
 * NO se acumulan — y eso hay que respetarlo aunque acá tiente mostrar el
 * descuento más grande, porque el precio que se publica tiene que ser el que
 * la caja va a cobrar.
 *
 * Los combos quedan fuera: se resuelven con el carrito armado, no por
 * producto, así que no pueden cambiar un precio unitario. Igual se publican
 * en la lista de promos, porque para el cliente son lo más atractivo.
 */
function promoDe(productId: string, categoryId: string | null, activas: any[]): any | null {
  const aplican = activas.filter(p => p.type !== 'combo');
  return aplican.find(p => p.applies_to === 'products' && (p.product_ids ?? []).includes(productId))
    ?? (categoryId ? aplican.find(p => p.applies_to === 'category' && p.category_id === categoryId) : null)
    ?? aplican.find(p => p.applies_to === 'all')
    ?? null;
}

/** El precio con la promo aplicada, SIN impuesto (el impuesto se suma después). */
function precioConPromo(base: number, p: any): number {
  if (p.type === 'percentage') return base * (1 - Number(p.value) / 100);
  if (p.type === 'fixed')      return Math.max(0, base - Number(p.value));
  return base;   // 2×1, combo y por cantidad dependen de la cantidad
}

const SectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  note: z.string().optional().nullable(),
  product_ids: z.array(z.string()).default([]),
});

const MenuSchema = z.object({
  slug: z.string().min(2).max(60).optional(),
  published: z.boolean().optional(),
  theme: z.string().optional(),
  header: z.record(z.any()).optional(),
  config: z.record(z.any()).optional(),
  sections: z.array(SectionSchema).optional(),
});

/** Slug seguro para URL: sin tildes, sin espacios, sin sorpresas. */
function slugify(s: string): string {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quita tildes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'menu';
}

/** Un slug libre, agregando sufijo si hace falta. */
async function freeSlug(base: string, tenantId: string, kind: TipoPagina = 'menu'): Promise<string> {
  const root = slugify(base);
  for (let i = 0; i < 30; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const { data } = await db.from('digital_menus')
      .select('tenant_id, kind').eq('slug', candidate).maybeSingle();
    // Libre si no existe, o si ya es de este mismo negocio Y de este mismo tipo:
    // el catálogo y la carta del mismo negocio NO pueden compartir slug, porque
    // la página pública resuelve por slug y no sabría cuál mostrar.
    if (!data || ((data as any).tenant_id === tenantId && (data as any).kind === kind)) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

// GET / — el menú del negocio. Si no existe todavía, se arma uno en blanco con
// las secciones sacadas de las categorías: empezar de una página vacía es la
// forma más segura de que nadie lo termine.
digitalMenu.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const kind = tipoDe(c);
    let sel: any = await db.from('digital_menus')
      .select('*').eq('tenant_id', tenantId).eq('kind', kind).maybeSingle();
    // Mientras la migración 117 no esté corrida no existe la columna `kind`:
    // se responde la fila única de siempre, que es la carta.
    if (sel.error && /kind/i.test(sel.error.message ?? '')) {
      sel = kind === 'menu'
        ? await db.from('digital_menus').select('*').eq('tenant_id', tenantId).maybeSingle()
        : { data: null, error: null };
    }
    if (sel.error && !/does not exist|schema cache/i.test(sel.error.message)) throw new Error(sel.error.message);
    if (sel.data) return ok(c, { ...sel.data, kind });

    const { data: t } = await db.from('tenants').select('name').eq('id', tenantId).maybeSingle();
    const name = (t as any)?.name ?? 'Mi negocio';
    const { data: cats } = await db.from('product_categories')
      .select('id, name').eq('tenant_id', tenantId).order('name');

    // El slug arranca distinto para cada uno: si no, la carta y el catálogo del
    // mismo negocio pelearían por el mismo enlace y el segundo quedaría con un
    // «-2» pegado sin que nadie entienda por qué.
    const base = kind === 'catalogo' ? `${name} catalogo` : name;

    return ok(c, {
      tenant_id: tenantId,
      kind,
      slug: await freeSlug(base, tenantId, kind),
      published: false,
      theme: 'clasico',
      header: { name, tagline: '', logo_url: '', cover_url: '', phone: '', address: '', hours: '' },
      config: kind === 'catalogo'
        // El catálogo no tiene alérgenos ni dietas: lo que su cliente necesita
        // es el código del producto y si hay existencias.
        ? { accent: '#1D4ED8', show_photos: true, show_sku: true, show_stock: false, show_prices: true, note: '' }
        : { accent: '#0F766E', show_photos: true, show_allergens: true, show_prices: true, note: '' },
      sections: (cats ?? []).map((x: any) => ({ id: x.id, title: x.name, note: '', product_ids: [] })),
      views: 0,
      _new: true,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT / — guarda el menú completo.
digitalMenu.put('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = MenuSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.errors[0]?.message ?? 'Datos inválidos', 422);
    const body = parsed.data;

    const kind = tipoDe(c);
    let cur: any = await db.from('digital_menus')
      .select('slug').eq('tenant_id', tenantId).eq('kind', kind).maybeSingle();
    if (cur.error && /kind/i.test(cur.error.message ?? '')) {
      if (kind === 'catalogo') {
        return fail(c, 'El catálogo digital necesita la migración 117 (columna «kind»). Correla y volvé a intentar.', 409);
      }
      cur = await db.from('digital_menus').select('slug').eq('tenant_id', tenantId).maybeSingle();
    }
    const current = cur.data;

    // El slug solo se recalcula si cambió: un QR ya impreso apunta al anterior, y
    // regenerarlo en cada guardado dejaría carteles inservibles pegados en las mesas.
    let slug = (current as any)?.slug ?? null;
    if (body.slug && slugify(body.slug) !== slug) {
      slug = await freeSlug(body.slug, tenantId, kind);
    }
    if (!slug) {
      const { data: t } = await db.from('tenants').select('name').eq('id', tenantId).maybeSingle();
      const base = (t as any)?.name ?? (kind === 'catalogo' ? 'catalogo' : 'menu');
      slug = await freeSlug(kind === 'catalogo' ? `${base} catalogo` : base, tenantId, kind);
    }

    const row: any = { tenant_id: tenantId, kind, slug, updated_at: new Date().toISOString() };
    if (body.published !== undefined) row.published = body.published;
    if (body.theme) row.theme = body.theme;
    if (body.header) row.header = body.header;
    if (body.config) row.config = body.config;
    if (body.sections) row.sections = body.sections;

    let up: any = await db.from('digital_menus')
      .upsert(row, { onConflict: 'tenant_id,kind' }).select('*').single();
    // Sin la migración 117 el conflicto sigue siendo solo por tenant_id.
    if (up.error && /kind/i.test(up.error.message ?? '')) {
      const { kind: _k, ...sinKind } = row;
      up = await db.from('digital_menus').upsert(sinKind, { onConflict: 'tenant_id' }).select('*').single();
    }
    if (up.error) throw new Error(up.error.message);
    return ok(c, up.data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ══════════════════════════════════════════════════════════════════════════
// PÁGINA PÚBLICA (sin sesión)
// ══════════════════════════════════════════════════════════════════════════

export const publicMenu = new Hono();

// GET /:slug — lo que ve el cliente.
//
// Devuelve SOLO campos elegidos a mano. La tentación de mandar el producto
// entero y filtrar en el front es justo lo que expondría costos y márgenes a
// cualquiera que escanee el código de una mesa.
publicMenu.get('/:slug', async (c) => {
  try {
    const slug = String(c.req.param('slug') ?? '').toLowerCase();
    if (!slug) return fail(c, 'Menú no encontrado', 404);

    let sel: any = await db.from('digital_menus')
      .select('tenant_id, slug, kind, published, theme, header, config, sections')
      .eq('slug', slug).maybeSingle();
    if (sel.error && /kind/i.test(sel.error.message ?? '')) {     // migración 117 sin correr
      sel = await db.from('digital_menus')
        .select('tenant_id, slug, published, theme, header, config, sections')
        .eq('slug', slug).maybeSingle();
    }
    const { data: menu, error } = sel;
    // Un menú sin publicar responde igual que uno inexistente: decir «existe pero
    // está oculto» ya es contar algo que no le corresponde a un desconocido.
    if (error || !menu || !(menu as any).published) return fail(c, 'Menú no encontrado', 404);

    const tenantId = (menu as any).tenant_id;
    const kind: TipoPagina = esCatalogo((menu as any).kind) ? 'catalogo' : 'menu';

    /**
     * EL PRECIO QUE SE PUBLICA, con impuesto o sin él.
     *
     * El sistema guarda los precios SIN impuesto y se lo suma al cobrar. Eso
     * está bien para la contabilidad, pero esta página la mira un cliente desde
     * la calle: en Costa Rica el precio exhibido debe incluir los impuestos, y
     * publicar el neto deja cosas como «Cerdito valiente ₡5.309,73» —un precio
     * con céntimos que nadie cobra— en lugar de los ₡6.000 que se pagan.
     *
     * Por eso va CON impuesto salvo que el negocio diga lo contrario: un
     * mayorista que le vende a otros negocios sí quiere mostrar el precio sin
     * IVA, y para eso está el interruptor.
     *
     * Si el negocio no cobra impuesto —régimen simplificado, por ejemplo— no
     * hay nada que sumar y el precio sale tal cual.
     */
    const cfgMenu: any = (menu as any).config ?? {};
    const conIva = cfgMenu.precios_con_iva !== false;
    let impuestoActivo = true;
    let ivaGeneral = 13;
    try {
      const { data: gen } = await db.from('settings').select('config')
        .eq('tenant_id', tenantId).eq('type', 'general').maybeSingle();
      const g: any = (gen as any)?.config ?? {};
      if (g.taxEnabled === false) impuestoActivo = false;
      if (Number(g.taxPercentage) >= 0) ivaGeneral = Number(g.taxPercentage);
    } catch { /* ante la duda, el 13% de ley */ }

    /** Mismo cálculo y mismo redondeo que el POS (`utils/priceUtils`). */
    const precioPublicado = (base: number, ivaProducto: any): number => {
      const b = Number(base) || 0;
      if (!conIva || !impuestoActivo) return b;
      const pct = ivaProducto != null && ivaProducto !== '' ? Number(ivaProducto) : ivaGeneral;
      return Math.round((b + b * ((Number(pct) || 0) / 100)) * 100) / 100;
    };
    const sections: any[] = Array.isArray((menu as any).sections) ? (menu as any).sections : [];
    const ids = [...new Set(sections.flatMap(s => s.product_ids ?? []))] as string[];

    let itemById = new Map<string, any>();
    if (ids.length) {
      // El catálogo necesita dos datos más que la carta: el código con el que el
      // cliente pide el producto, y si hay existencias. Se piden solo cuando
      // corresponde — un `select` de más en una página sin sesión es una
      // filtración, y acá cualquiera que escanee el QR es un desconocido.
      // `iva_rate` viaja para poder publicar el precio final: cada producto
      // puede tener su tarifa (13%, 1% de canasta básica, exento).
      // `category_id` viaja para poder resolver las promos por categoría.
      const cols = kind === 'catalogo'
        ? 'id, name, description, unit_price, image_url, iva_rate, category_id, sku, stock_quantity, tracks_stock'
        : 'id, name, description, unit_price, image_url, iva_rate, category_id';
      let prods: any = await db.from('products')
        .select(cols).eq('tenant_id', tenantId).in('id', ids).is('deleted_at', null);
      if (prods.error && /sku|stock_quantity|tracks_stock|iva_rate|category_id/i.test(prods.error.message ?? '')) {
        prods = await db.from('products')
          .select('id, name, description, unit_price, image_url')
          .eq('tenant_id', tenantId).in('id', ids).is('deleted_at', null);
      }
      for (const p of (prods.data ?? []) as any[]) {
        const it: any = {
          id: p.id, name: p.name, description: p.description ?? null,
          price: precioPublicado(p.unit_price, p.iva_rate), image_url: p.image_url ?? null,
          /** Internos: se usan para resolver la promo y se borran antes de responder. */
          _neto: Number(p.unit_price) || 0, _iva: p.iva_rate, _cat: p.category_id ?? null,
        };
        if (kind === 'catalogo') {
          it.sku = p.sku ?? null;
          // Se publica HAY / NO HAY, nunca la cantidad: cuánto stock tiene el
          // negocio no es asunto de quien mira la vitrina, y además envejece mal.
          it.disponible = p.tracks_stock === false ? true : Number(p.stock_quantity ?? 0) > 0;
        }
        itemById.set(p.id, it);
      }

      // Datos de la RECETA que enriquecen el plato: foto, alérgenos y dietas.
      // Son exactamente los que un cliente quiere saber y que hoy nadie publica.
      // Solo para la carta: un tornillo no tiene alérgenos.
      if (kind === 'menu') {
        try {
          const { data: recs } = await db.from('recipes')
            .select('product_id, photo_url, allergens, diet_tags, prep_minutes')
            .eq('tenant_id', tenantId).in('product_id', ids);
          for (const r of (recs ?? []) as any[]) {
            const it = itemById.get(r.product_id);
            if (!it) continue;
            it.image_url = r.photo_url ?? it.image_url;
            it.allergens = r.allergens ?? null;
            it.diet_tags = r.diet_tags ?? null;
          }
        } catch { /* sin recetas el menú igual se muestra */ }
      }
    }

    /**
     * PROMOCIONES VIGENTES HOY.
     *
     * Solo las que están corriendo: una programada para la semana que viene no
     * va en la vitrina (el cliente la pediría hoy) y una vencida tampoco. Se
     * filtra por fecha acá y no en la consulta porque `ends_at` vacío significa
     * «permanente», y eso en SQL pide un OR que se lee peor que esta línea.
     */
    let promosOut: any[] = [];
    try {
      const hoy = hoyCR();
      const { data: todas } = await db.from('promotions')
        .select('id, name, description, type, value, combo_mode, bundle_qty, applies_to, category_id, product_ids, starts_at, ends_at, is_active')
        .eq('tenant_id', tenantId).eq('is_active', true);
      const activas = ((todas ?? []) as any[])
        .filter(p => p.starts_at <= hoy && (!p.ends_at || p.ends_at >= hoy));

      if (activas.length) {
        /** A qué ítems PUBLICADOS les toca cada promo. Una promo que no alcanza
         *  nada de lo publicado no se muestra: sería ofrecer algo que el cliente
         *  no puede encontrar en la página. */
        const alcance = new Map<string, string[]>();
        for (const it of itemById.values()) {
          const pr = promoDe(it.id, it._cat, activas);
          if (pr) {
            // El descuento se aplica al precio NETO y el impuesto se suma
            // después, igual que en la caja. Al revés —descontar sobre el
            // precio con IVA— da unos colones de diferencia en los montos
            // fijos, y esa diferencia aparece justo al pagar.
            const neto = precioConPromo(it._neto, pr);
            const nuevo = precioPublicado(neto, it._iva);
            if (nuevo < it.price) { it.precio_antes = it.price; it.price = nuevo; }
            it.promo_id = pr.id;
            it.promo_etiqueta = etiquetaPromo(pr);
            alcance.set(pr.id, [...(alcance.get(pr.id) ?? []), it.id]);
          }
        }
        // Los combos no cambian precios unitarios, pero sí nombran productos:
        // se les calcula el alcance aparte para que el filtro de la página
        // pueda mostrar de qué está hecho el combo.
        for (const pr of activas.filter(p => p.type === 'combo')) {
          const dentro = (pr.product_ids ?? []).filter((id: string) => itemById.has(id));
          if (dentro.length) alcance.set(pr.id, dentro);
        }

        promosOut = activas
          .filter(p => (alcance.get(p.id) ?? []).length > 0)
          .map(p => ({
            id: p.id, nombre: p.name, descripcion: p.description ?? null,
            tipo: p.type, etiqueta: etiquetaPromo(p),
            /**
             * Las DOS fechas, no solo la de fin.
             *
             * Una promo que dice «hasta el 20» deja al cliente sin saber si ya
             * está corriendo o arranca mañana, y la pregunta termina en el
             * mostrador. Con las dos, el cartel se lee solo. La de inicio
             * puede estar en el pasado: igual se publica, porque «del 1 al 20»
             * es lo que la gente espera ver en una oferta.
             */
            empieza: p.starts_at || null,
            termina: p.ends_at || null,
            item_ids: alcance.get(p.id) ?? [],
          }));
      }
    } catch { /* sin promos la carta se muestra igual: nunca deben costar una página */ }

    // Los platos que ya no existen se caen solos: un menú que ofrece algo
    // inexistente hace quedar mal al negocio delante del cliente.
    const outSections = sections.map(s => ({
      id: s.id, title: s.title, note: s.note ?? null,
      items: (s.product_ids ?? []).map((id: string) => itemById.get(id)).filter(Boolean),
    })).filter(s => s.items.length > 0);

    // Fuera los campos internos: el costo neto y la categoría del producto no
    // son asunto de quien escanea un QR desde la calle.
    for (const sec of outSections) {
      for (const it of sec.items) { delete it._neto; delete it._iva; delete it._cat; }
    }

    // Contador de visitas. Se hace leyendo y sumando, no con un RPC: Supabase
    // resuelve (no rechaza) cuando la función no existe, así que un `.catch()`
    // nunca se habría disparado y el contador se habría quedado en cero para
    // siempre sin que nada avisara. Va sin `await` para no demorar la carta.
    void (async () => {
      try {
        const { data: cur } = await db.from('digital_menus')
          .select('views').eq('slug', slug).maybeSingle();
        await db.from('digital_menus')
          .update({ views: Number((cur as any)?.views ?? 0) + 1 }).eq('slug', slug);
      } catch { /* el contador nunca debe costar una carta sin cargar */ }
    })();

    return ok(c, {
      slug, kind, theme: (menu as any).theme ?? 'clasico',
      header: (menu as any).header ?? {},
      // `impuesto_incluido` se resuelve acá y no en la página: depende de la
      // configuración del negocio, que el navegador no puede leer.
      config: { ...cfgMenu, impuesto_incluido: impuestoActivo ? conIva : null },
      sections: outSections,
      promos: promosOut,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default digitalMenu;
