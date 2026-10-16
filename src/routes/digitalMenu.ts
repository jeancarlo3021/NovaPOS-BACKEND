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
      const cols = kind === 'catalogo'
        ? 'id, name, description, unit_price, image_url, iva_rate, sku, stock_quantity, tracks_stock'
        : 'id, name, description, unit_price, image_url, iva_rate';
      let prods: any = await db.from('products')
        .select(cols).eq('tenant_id', tenantId).in('id', ids).is('deleted_at', null);
      if (prods.error && /sku|stock_quantity|tracks_stock|iva_rate/i.test(prods.error.message ?? '')) {
        prods = await db.from('products')
          .select('id, name, description, unit_price, image_url')
          .eq('tenant_id', tenantId).in('id', ids).is('deleted_at', null);
      }
      for (const p of (prods.data ?? []) as any[]) {
        const it: any = {
          id: p.id, name: p.name, description: p.description ?? null,
          price: precioPublicado(p.unit_price, p.iva_rate), image_url: p.image_url ?? null,
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

    // Los platos que ya no existen se caen solos: un menú que ofrece algo
    // inexistente hace quedar mal al negocio delante del cliente.
    const outSections = sections.map(s => ({
      id: s.id, title: s.title, note: s.note ?? null,
      items: (s.product_ids ?? []).map((id: string) => itemById.get(id)).filter(Boolean),
    })).filter(s => s.items.length > 0);

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
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default digitalMenu;
