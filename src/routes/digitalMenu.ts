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
async function freeSlug(base: string, tenantId: string): Promise<string> {
  const root = slugify(base);
  for (let i = 0; i < 30; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const { data } = await db.from('digital_menus')
      .select('tenant_id').eq('slug', candidate).maybeSingle();
    if (!data || (data as any).tenant_id === tenantId) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

// GET / — el menú del negocio. Si no existe todavía, se arma uno en blanco con
// las secciones sacadas de las categorías: empezar de una página vacía es la
// forma más segura de que nadie lo termine.
digitalMenu.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('digital_menus')
      .select('*').eq('tenant_id', tenantId).maybeSingle();
    if (error && !/does not exist|schema cache/i.test(error.message)) throw new Error(error.message);
    if (data) return ok(c, data);

    const { data: t } = await db.from('tenants').select('name').eq('id', tenantId).maybeSingle();
    const name = (t as any)?.name ?? 'Mi negocio';
    const { data: cats } = await db.from('product_categories')
      .select('id, name').eq('tenant_id', tenantId).order('name');

    return ok(c, {
      tenant_id: tenantId,
      slug: await freeSlug(name, tenantId),
      published: false,
      theme: 'clasico',
      header: { name, tagline: '', logo_url: '', cover_url: '', phone: '', address: '', hours: '' },
      config: { accent: '#0F766E', show_photos: true, show_allergens: true, show_prices: true, note: '' },
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

    const { data: current } = await db.from('digital_menus')
      .select('slug').eq('tenant_id', tenantId).maybeSingle();

    // El slug solo se recalcula si cambió: un QR ya impreso apunta al anterior, y
    // regenerarlo en cada guardado dejaría carteles inservibles pegados en las mesas.
    let slug = (current as any)?.slug ?? null;
    if (body.slug && slugify(body.slug) !== slug) {
      slug = await freeSlug(body.slug, tenantId);
    }
    if (!slug) {
      const { data: t } = await db.from('tenants').select('name').eq('id', tenantId).maybeSingle();
      slug = await freeSlug((t as any)?.name ?? 'menu', tenantId);
    }

    const row: any = { tenant_id: tenantId, slug, updated_at: new Date().toISOString() };
    if (body.published !== undefined) row.published = body.published;
    if (body.theme) row.theme = body.theme;
    if (body.header) row.header = body.header;
    if (body.config) row.config = body.config;
    if (body.sections) row.sections = body.sections;

    const { data, error } = await db.from('digital_menus')
      .upsert(row, { onConflict: 'tenant_id' }).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
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

    const { data: menu, error } = await db.from('digital_menus')
      .select('tenant_id, slug, published, theme, header, config, sections')
      .eq('slug', slug).maybeSingle();
    // Un menú sin publicar responde igual que uno inexistente: decir «existe pero
    // está oculto» ya es contar algo que no le corresponde a un desconocido.
    if (error || !menu || !(menu as any).published) return fail(c, 'Menú no encontrado', 404);

    const tenantId = (menu as any).tenant_id;
    const sections: any[] = Array.isArray((menu as any).sections) ? (menu as any).sections : [];
    const ids = [...new Set(sections.flatMap(s => s.product_ids ?? []))] as string[];

    let itemById = new Map<string, any>();
    if (ids.length) {
      const { data: prods } = await db.from('products')
        .select('id, name, description, unit_price, image_url')
        .eq('tenant_id', tenantId).in('id', ids).is('deleted_at', null);
      for (const p of (prods ?? []) as any[]) {
        itemById.set(p.id, {
          id: p.id, name: p.name, description: p.description ?? null,
          price: Number(p.unit_price) || 0, image_url: p.image_url ?? null,
        });
      }

      // Datos de la RECETA que enriquecen el plato: foto, alérgenos y dietas.
      // Son exactamente los que un cliente quiere saber y que hoy nadie publica.
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
      slug, theme: (menu as any).theme ?? 'clasico',
      header: (menu as any).header ?? {},
      config: (menu as any).config ?? {},
      sections: outSections,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default digitalMenu;
