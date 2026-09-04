import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * Solicitudes de demo. Ver migrations/98_demo_requests.sql
 *
 * El vendedor pide la demo con los módulos que el prospecto necesita; quien la
 * arma (gerencia) la aprueba, la entrega y anota hasta cuándo dura. Cada
 * solicitud es de quien la pidió: un vendedor no ve la cartera de otro.
 */
const demoRequests = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const STATUSES = ['pendiente', 'aprobada', 'rechazada', 'entregada', 'convertida', 'vencida'] as const;
/** Días que sobrevive una demo sin convertirse antes de borrarse sola. */
export const DEMO_PURGE_DAYS = 30;
const MANAGERS = new Set(['owner', 'admin', 'gerente']);

const DemoSchema = z.object({
  business_name: z.string().min(1),
  contact_name: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  business_type: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  modules: z.array(z.string()).min(1),
  days: z.number().int().positive().max(180).optional().default(15),
});

/** ¿Es gerencia? Se confirma contra la tabla: el token puede venir sin rol. */
async function isManager(c: any): Promise<boolean> {
  const role = String(c.get('role') ?? '');
  if (role) return MANAGERS.has(role);
  const { data } = await db.from('users').select('role').eq('id', c.get('userId')).maybeSingle();
  return MANAGERS.has(String((data as any)?.role ?? ''));
}

/**
 * Credenciales de la demo a partir del nombre del negocio (o del contacto).
 *
 * Tienen que poder DICTARSE por teléfono: sin tildes, sin eñes, sin símbolos
 * raros. El usuario sale del nombre para que el vendedor lo reconozca en la
 * lista, y la clave lleva cuatro dígitos para que no sea adivinable de una.
 */
function slugFor(name: string): string {
  const base = String(name ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // quita tildes
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['los', 'las', 'del', 'para', 'con'].includes(w))
    .slice(0, 2)
    .join('');
  return (base || 'demo').slice(0, 14);
}

async function makeCredentials(tenantId: string, businessName: string, contactName?: string | null) {
  const slug = slugFor(businessName) || slugFor(contactName ?? '') || 'demo';
  const digits = () => String(Math.floor(1000 + Math.random() * 9000));

  /**
   * El usuario tiene que estar libre en LOS DOS lados: en las solicitudes y en
   * los usuarios de verdad. Mirar solo las solicitudes producía nombres que ya
   * existían como usuario —de una demo borrada, o de un alta que falló a mitad—
   * y el alta moría con "Ya existe un usuario…" por más que se regenerara.
   */
  const libre = async (candidate: string): Promise<boolean> => {
    const email = `${candidate}@nexoerp.local`;
    const [sol, usr] = await Promise.all([
      db.from('demo_requests').select('id').eq('tenant_id', tenantId).eq('demo_user', candidate).maybeSingle(),
      db.from('users').select('id').eq('email', email).maybeSingle(),
    ]);
    return !(sol as any)?.data && !(usr as any)?.data;
  };

  let user = `demo-${slug}`;
  if (!(await libre(user))) {
    let ok = false;
    for (let i = 2; i <= 9 && !ok; i++) {
      user = `demo-${slug}${i}`;
      ok = await libre(user);
    }
    // Agotados los números, sufijo al azar: siempre tiene que salir un usuario
    // utilizable, si no el vendedor queda trabado sin salida.
    for (let i = 0; i < 10 && !ok; i++) {
      user = `demo-${slug}-${Math.random().toString(36).slice(2, 5)}`;
      ok = await libre(user);
    }
    if (!ok) throw new Error('No se pudo generar un usuario libre. Escribí uno a mano.');
  }
  // La clave tiene que servir para entrar: Supabase exige 6 caracteres, y un
  // slug corto ('soda') dejaría una clave de 8 justos — se rellena para que
  // nunca quede por debajo.
  const pass = `${slug}${digits()}`;
  return { demo_user: user, demo_password: pass.length >= 8 ? pass : `demo${pass}` };
}

async function nextNumber(tenantId: string): Promise<string> {
  const { count } = await db.from('demo_requests')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  return `DEMO-${String((count ?? 0) + 1).padStart(4, '0')}`;
}

// GET / — ?status= &q=. El vendedor ve solo las suyas.
demoRequests.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const manager = await isManager(c);

    let query = db.from('demo_requests').select('*').eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }).limit(500);

    const status = c.req.query('status');
    if (status && status !== 'all') {
      if (status === 'abiertas') query = query.in('status', ['pendiente', 'aprobada']);
      else query = query.eq('status', status);
    }
    const q = c.req.query('q');
    if (q) query = query.or(`business_name.ilike.%${q}%,contact_name.ilike.%${q}%,number.ilike.%${q}%`);
    if (!manager) query = query.eq('requested_by', userId);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

demoRequests.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const parsed = DemoSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return fail(c, 'Faltan datos (el negocio y al menos un módulo): ' + parsed.error.message, 422);
    }

    // Nombre del vendedor como snapshot: la solicitud tiene que seguir legible
    // aunque después se le cambie el nombre o se desactive el usuario.
    const { data: u } = await db.from('users')
      .select('full_name, email').eq('id', userId).maybeSingle();

    const creds = await makeCredentials(tenantId, parsed.data.business_name, parsed.data.contact_name);

    let { data, error } = await db.from('demo_requests').insert({
      tenant_id: tenantId,
      number: await nextNumber(tenantId),
      ...parsed.data,
      ...creds,
      status: 'pendiente',
      requested_by: userId,
      requester_name: (u as any)?.full_name || (u as any)?.email || null,
    }).select('*').single();

    // Sin la migración 99 no existe demo_password: la solicitud vale más que la
    // credencial sugerida, así que se guarda igual.
    if (error && /demo_password|demo_user/i.test(error.message)) {
      const retry = await db.from('demo_requests').insert({
        tenant_id: tenantId,
        number: await nextNumber(tenantId),
        ...parsed.data,
        status: 'pendiente',
        requested_by: userId,
        requester_name: (u as any)?.full_name || (u as any)?.email || null,
      }).select('*').single();
      data = retry.data; error = retry.error;
    }
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

demoRequests.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const manager = await isManager(c);

    const { data: prev } = await db.from('demo_requests')
      .select('requested_by, status').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!prev) return fail(c, 'Solicitud no encontrada', 404);
    if (!manager && String((prev as any).requested_by ?? '') !== userId) {
      return fail(c, 'Esta solicitud es de otro vendedor', 403);
    }
    // Ya entregada: cambiarla dejaría la demo real diciendo otra cosa.
    if (!manager && (prev as any).status !== 'pendiente') {
      return fail(c, 'La solicitud ya fue revisada: pedile el cambio a quien arma las demos', 409);
    }

    const body = await c.req.json().catch(() => ({} as any));
    const patch: any = { updated_at: new Date().toISOString() };
    for (const f of ['business_name', 'contact_name', 'phone', 'email', 'business_type',
      'notes', 'modules', 'days']) {
      if (body?.[f] !== undefined) patch[f] = body[f] === '' ? null : body[f];
    }
    const { data, error } = await db.from('demo_requests').update(patch)
      .eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});


/**
 * Crea el negocio y su usuario a partir de una solicitud.
 *
 * Sirve para los dos caminos: la DEMO (plan armado con los módulos pedidos, con
 * vencimiento y borrado automático) y el CLIENTE que compra de una (plan real,
 * sin etiqueta de demo y sin fecha de borrado). Es el mismo trabajo; lo único
 * que cambia es con qué plan nace y si se marca como prueba.
 */
async function createTenantForRequest(req: any, opts: {
  ownerId: string;
  demo: boolean;
  planId?: string | null;
  days?: number;
}): Promise<{ tenantId: string; authId: string; email: string; user: string; password: string }> {
  const user = String(req.demo_user ?? '').trim();
  const pass = String(req.demo_password ?? '').trim();
  if (!user || pass.length < 6) {
    throw new Error('La solicitud no tiene usuario y clave válidos. Regeneralos y volvé a intentar.');
  }
  const email = user.includes('@') ? user.toLowerCase() : `${user.toLowerCase()}@nexoerp.local`;

  const { data: dup } = await db.from('users').select('id').eq('email', email).maybeSingle();
  if (dup) throw new Error(`Ya existe un usuario "${user}". Regenerá las credenciales.`);

  const uuid = (globalThis.crypto as any)?.randomUUID?.()
    ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const { data: created, error: tErr } = await db.from('tenants').insert({
    name: opts.demo ? `${req.business_name} (demo)` : req.business_name,
    owner_id: opts.ownerId,
    status: 'active',
    is_demo: opts.demo,
    plan_id: opts.planId ?? null,
    schema_name: `tenant_${String(uuid).replace(/-/g, '_')}`,
  }).select('id').single();
  if (tErr) throw new Error(tErr.message);
  const tenantId = (created as any).id as string;

  let planId = opts.planId ?? null;
  let endsAt: Date;

  if (opts.demo) {
    // Plan propio de esta demo con EXACTAMENTE los módulos pedidos. Tocar uno
    // compartido le cambiaría los módulos a otros negocios.
    const features: Record<string, boolean> = {};
    for (const m of (req.modules ?? []) as string[]) features[m] = true;
    const { data: plan } = await db.from('subscription_plans').insert({
      name: `Demo · ${req.business_name}`.slice(0, 60),
      price: 0, billing_cycle: 'monthly', features, is_active: true,
    }).select('id').single();
    planId = (plan as any)?.id ?? null;
    endsAt = new Date(Date.now() + (opts.days ?? 15) * 86400000);
  } else {
    const { data: plan } = await db.from('subscription_plans')
      .select('billing_cycle').eq('id', planId ?? '').maybeSingle();
    const cycleDays = String((plan as any)?.billing_cycle ?? 'monthly').toLowerCase() === 'yearly' ? 365 : 30;
    endsAt = new Date(Date.now() + cycleDays * 86400000);
  }

  if (planId) {
    await db.from('tenants').update({ plan_id: planId }).eq('id', tenantId);
    const { data: sub } = await db.from('subscriptions').insert({
      tenant_id: tenantId, plan_id: planId, status: 'active',
      auto_renew: !opts.demo, ends_at: endsAt.toISOString(),
    }).select('id').single();
    if ((sub as any)?.id) {
      await db.from('tenants').update({ subscription_id: (sub as any).id }).eq('id', tenantId);
    }
  }

  const { data: authData, error: authError } = await db.auth.admin.createUser({
    email, password: pass, email_confirm: true,
  });
  if (authError) {
    if (/already (registered|exists)/i.test(authError.message)) {
      throw new Error(`Ya existe un usuario "${user}". Regenerá las credenciales.`);
    }
    throw new Error(authError.message);
  }
  if (!authData.user) throw new Error('No se pudo crear el usuario');

  const { error: uErr } = await db.from('users').insert({
    id: authData.user.id, email,
    full_name: req.contact_name || req.business_name,
    role: 'owner', tenant_id: tenantId,
  });
  if (uErr) throw new Error(uErr.message);

  await db.from('user_tenants').upsert({
    user_id: authData.user.id, tenant_id: tenantId, role: 'owner', is_default: true,
  }, { onConflict: 'user_id,tenant_id' });

  return { tenantId, authId: authData.user.id, email, user, password: pass };
}

// POST /:id/provision — ARMA la demo de verdad.
//
// Hasta acá las credenciales eran solo texto: nadie podía entrar con ellas. Esto
// crea el negocio de prueba, le activa los módulos pedidos y da de alta el
// usuario, de modo que el vendedor dicte el acceso y el cliente entre.
demoRequests.post('/:id/provision', async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  let createdAuthId: string | null = null;
  let createdTenantId: string | null = null;

  try {
    if (!(await isManager(c))) {
      return fail(c, 'Solo el administrador o el gerente pueden armar la demo', 403);
    }
    const { data: r } = await db.from('demo_requests')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!r) return fail(c, 'Solicitud no encontrada', 404);
    if ((r as any).demo_tenant_id) {
      return fail(c, 'Esta demo ya fue creada. Si hay que rehacerla, borrá el negocio de prueba primero.', 409);
    }

    const req = r as any;

    // Si el usuario guardado ya está ocupado (una demo anterior, un alta que
    // falló a mitad), se regenera SOLO y se sigue. Antes esto terminaba en un
    // "Ya existe un usuario…" que dejaba al vendedor sin salida.
    {
      const actual = String(req.demo_user ?? '').trim();
      const email = actual.includes('@') ? actual.toLowerCase() : `${actual.toLowerCase()}@nexoerp.local`;
      const { data: ocupado } = actual
        ? await db.from('users').select('id').eq('email', email).maybeSingle()
        : { data: null };
      if (!actual || ocupado) {
        const nuevas = await makeCredentials(tenantId, req.business_name, req.contact_name);
        await db.from('demo_requests').update({ ...nuevas, updated_at: new Date().toISOString() })
          .eq('id', id).eq('tenant_id', tenantId);
        req.demo_user = nuevas.demo_user;
        req.demo_password = nuevas.demo_password;
      }
    }

    const user = String(req.demo_user ?? '').trim();
    const pass = String(req.demo_password ?? '').trim();
    if (!user || pass.length < 6) {
      return fail(c, 'La solicitud no tiene usuario y clave válidos. Regeneralos y volvé a intentar.', 422);
    }
    const email = user.includes('@') ? user.toLowerCase() : `${user.toLowerCase()}@nexoerp.local`;

    const { data: dup } = await db.from('users').select('id').eq('email', email).maybeSingle();
    if (dup) return fail(c, `Ya existe un usuario "${user}". Regenerá las credenciales.`, 409);

    // 1) El negocio de prueba. Queda marcado como demo para poder limpiarlo
    //    después sin confundirlo con un cliente de verdad.
    const uuid = (globalThis.crypto as any)?.randomUUID?.()
      ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    const { data: created, error: tErr } = await db.from('tenants').insert({
      name: `${req.business_name} (demo)`,
      owner_id: c.get('userId'),
      status: 'active',
      is_demo: true,
      schema_name: `tenant_${String(uuid).replace(/-/g, '_')}`,
    }).select('id').single();
    if (tErr) throw new Error(tErr.message);
    createdTenantId = (created as any).id as string;

    // 2) Plan con EXACTAMENTE los módulos que pidió el vendedor. Se crea un plan
    //    propio de esta demo: tocar uno compartido cambiaría el de otros negocios.
    const features: Record<string, boolean> = {};
    for (const m of (req.modules ?? []) as string[]) features[m] = true;
    const dias = Number(req.days) || 15;
    const vence = req.expires_on
      ? new Date(String(req.expires_on) + 'T23:59:59')
      : new Date(Date.now() + dias * 86400000);

    const { data: plan } = await db.from('subscription_plans').insert({
      name: `Demo · ${req.business_name}`.slice(0, 60),
      price: 0,
      billing_cycle: 'monthly',
      features,
      is_active: true,
    }).select('id').single();

    if ((plan as any)?.id) {
      await db.from('tenants').update({ plan_id: (plan as any).id }).eq('id', createdTenantId);
      const { data: sub } = await db.from('subscriptions').insert({
        tenant_id: createdTenantId, plan_id: (plan as any).id,
        status: 'active', auto_renew: false,
        ends_at: vence.toISOString(),
      }).select('id').single();
      if ((sub as any)?.id) {
        await db.from('tenants').update({ subscription_id: (sub as any).id }).eq('id', createdTenantId);
      }
    }

    // 3) El usuario que va a entrar.
    const { data: authData, error: authError } = await db.auth.admin.createUser({
      email, password: pass, email_confirm: true,
    });
    if (authError) {
      if (/already (registered|exists)/i.test(authError.message)) {
        throw new Error(`Ya existe un usuario "${user}". Regenerá las credenciales.`);
      }
      throw new Error(authError.message);
    }
    if (!authData.user) throw new Error('No se pudo crear el usuario de la demo');
    createdAuthId = authData.user.id;

    const { error: uErr } = await db.from('users').insert({
      id: authData.user.id, email,
      full_name: req.contact_name || req.business_name,
      role: 'owner', tenant_id: createdTenantId,
    });
    if (uErr) throw new Error(uErr.message);

    await db.from('user_tenants').upsert({
      user_id: authData.user.id, tenant_id: createdTenantId, role: 'owner', is_default: true,
    }, { onConflict: 'user_id,tenant_id' });

    /**
     * El negocio queda a nombre del CLIENTE, no de quien armó la demo.
     *
     * Se crea con el vendedor como dueño porque en ese momento el usuario del
     * cliente todavía no existe —hay que crear el negocio antes de poder colgarle
     * un usuario—. Pero dejarlo así traía dos problemas de verdad:
     *
     *  · El vendedor terminaba siendo dueño de todos los negocios que armó, y
     *    corregirle el correo se los cambiaba TODOS de una.
     *  · Al pasar la demo a cliente, el negocio seguía sin ser suyo, y había que
     *    acordarse de traspasarlo a mano.
     *
     * Ahora, apenas existe el usuario del cliente, el negocio pasa a su nombre.
     */
    const { error: ownErr } = await db.from('tenants')
      .update({ owner_id: authData.user.id, updated_at: new Date().toISOString() })
      .eq('id', createdTenantId);
    if (ownErr) {
      // No se aborta el alta por esto: la demo ya funciona y el dueño se puede
      // corregir después con «Hacer dueño». Pero queda dicho en el registro.
      console.warn('[demo] no se pudo pasar la propiedad al cliente:', ownErr.message);
    }

    // 4) La solicitud queda entregada, con a dónde apunta y hasta cuándo dura.
    // Se borra sola 30 días después de que venza la prueba, salvo que la
    // conviertan a cliente. Sin esta fecha, las demos se acumulan para siempre.
    const purge = new Date(vence.getTime() + DEMO_PURGE_DAYS * 86400000);

    const { data: updated } = await db.from('demo_requests').update({
      status: 'entregada',
      demo_tenant_id: createdTenantId,
      expires_on: vence.toISOString().slice(0, 10),
      purge_on: purge.toISOString().slice(0, 10),
      delivered_at: new Date().toISOString(),
      reviewed_by: c.get('userId'),
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId).select('*').single();

    return ok(c, {
      ...(updated as any),
      login: { user, password: pass, email },
    });
  } catch (err: any) {
    // Sin rollback quedaría un negocio fantasma o un usuario que no entra a nada.
    if (createdAuthId) {
      try { await db.auth.admin.deleteUser(createdAuthId); } catch { /* ignore */ }
      try { await db.from('users').delete().eq('id', createdAuthId); } catch { /* ignore */ }
    }
    if (createdTenantId) {
      try { await db.from('tenants').delete().eq('id', createdTenantId); } catch { /* ignore */ }
    }
    return fail(c, err.message, 500);
  }
});

// GET /plans — planes disponibles para convertir una demo en cliente.
demoRequests.get('/plans', async (c) => {
  try {
    const { data, error } = await db.from('subscription_plans')
      .select('id, name, price, billing_cycle, is_active')
      .eq('is_active', true).order('price');
    if (error) throw new Error(error.message);
    // Los planes generados para cada demo no se ofrecen: son de un solo negocio.
    return ok(c, (data ?? []).filter((p: any) => !String(p.name ?? '').startsWith('Demo · ')));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/convert — al cliente le gustó: se le asigna plan y deja de ser demo.
//
// El negocio NO se recrea: conserva los productos, clientes y ventas que cargó
// durante la prueba. Lo único que cambia es el plan, la etiqueta y que ya no se
// borra solo.
demoRequests.post('/:id/convert', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    if (!(await isManager(c))) {
      return fail(c, 'Solo el administrador o el gerente pueden convertir una demo en cliente', 403);
    }
    const body = await c.req.json().catch(() => ({} as any));
    const planId = String(body?.plan_id ?? '').trim();
    if (!planId) return fail(c, 'Elegí el plan que va a llevar el cliente', 422);

    const { data: r } = await db.from('demo_requests')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!r) return fail(c, 'Solicitud no encontrada', 404);
    if ((r as any).converted_at) return fail(c, 'Esta solicitud ya se convirtió en cliente', 409);

    const { data: plan } = await db.from('subscription_plans')
      .select('id, billing_cycle').eq('id', planId).maybeSingle();
    if (!plan) return fail(c, 'El plan elegido no existe', 404);

    // Compró SIN probar: no hay demo que convertir, se crea el negocio directo
    // como cliente. Es el caso del que ya lo vio en otro local y lo quiere ya.
    let demoTenant = (r as any).demo_tenant_id;
    if (!demoTenant) {
      const nuevo = await createTenantForRequest(r, {
        ownerId: c.get('userId'), demo: false, planId,
      });
      const { data: directo } = await db.from('demo_requests').update({
        status: 'convertida',
        demo_tenant_id: nuevo.tenantId,
        converted_plan_id: planId,
        converted_at: new Date().toISOString(),
        delivered_at: new Date().toISOString(),
        purge_on: null,
        expires_on: null,
        reviewed_by: c.get('userId'),
        updated_at: new Date().toISOString(),
      }).eq('id', id).eq('tenant_id', tenantId).select('*').single();
      return ok(c, { ...(directo as any), login: { user: nuevo.user, password: nuevo.password, email: nuevo.email } });
    }

    // 1) El negocio deja de ser demo y se queda con su nombre real.
    const { data: t } = await db.from('tenants')
      .select('name').eq('id', demoTenant).maybeSingle();
    const cleanName = String((t as any)?.name ?? (r as any).business_name)
      .replace(/\s*\(demo\)\s*$/i, '').trim() || (r as any).business_name;

    const { error: tErr } = await db.from('tenants').update({
      name: cleanName, is_demo: false, plan_id: planId, status: 'active',
    }).eq('id', demoTenant);
    if (tErr) throw new Error(tErr.message);

    // 2) Suscripción real con el ciclo del plan. La de la prueba se cancela para
    //    que no queden dos activas peleando por la misma fecha de corte.
    await db.from('subscriptions')
      .update({ status: 'cancelled', auto_renew: false, updated_at: new Date().toISOString() })
      .eq('tenant_id', demoTenant).eq('status', 'active');

    const cycleDays = String((plan as any).billing_cycle ?? 'monthly').toLowerCase() === 'yearly' ? 365 : 30;
    const { data: sub } = await db.from('subscriptions').insert({
      tenant_id: demoTenant, plan_id: planId, status: 'active', auto_renew: true,
      ends_at: new Date(Date.now() + cycleDays * 86400000).toISOString(),
    }).select('id').single();
    if ((sub as any)?.id) {
      await db.from('tenants').update({ subscription_id: (sub as any).id }).eq('id', demoTenant);
    }

    // 3) La solicitud queda como convertida y sin fecha de borrado.
    const { data: updated } = await db.from('demo_requests').update({
      status: 'convertida',
      converted_plan_id: planId,
      converted_at: new Date().toISOString(),
      purge_on: null,
      reviewed_by: c.get('userId'),
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId).select('*').single();

    return ok(c, updated);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/credentials — vuelve a generar usuario y clave de la demo.
demoRequests.post('/:id/credentials', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const manager = await isManager(c);

    const { data: prev } = await db.from('demo_requests')
      .select('business_name, contact_name, requested_by').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!prev) return fail(c, 'Solicitud no encontrada', 404);
    if (!manager && String((prev as any).requested_by ?? '') !== userId) {
      return fail(c, 'Esta solicitud es de otro vendedor', 403);
    }

    const body = await c.req.json().catch(() => ({} as any));
    const creds = body?.demo_user
      ? { demo_user: String(body.demo_user).trim(), demo_password: String(body?.demo_password ?? '').trim() || undefined }
      : await makeCredentials(tenantId, (prev as any).business_name, (prev as any).contact_name);

    const { data, error } = await db.from('demo_requests')
      .update({ ...creds, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select('*').single();
    if (error) {
      if (/duplicate|unique/i.test(error.message)) {
        return fail(c, 'Ese usuario ya está usado en otra demo. Probá otro nombre.', 409);
      }
      throw new Error(error.message);
    }
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /:id/status — aprobar, rechazar o marcar entregada. Solo gerencia.
demoRequests.post('/:id/status', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    if (!(await isManager(c))) {
      return fail(c, 'Solo el administrador o el gerente pueden aprobar o entregar demos', 403);
    }
    const body = await c.req.json().catch(() => ({} as any));
    const status = String(body?.status ?? '');
    if (!(STATUSES as readonly string[]).includes(status)) return fail(c, 'Estado inválido', 422);
    if (status === 'rechazada' && !String(body?.reject_reason ?? '').trim()) {
      return fail(c, 'Poné por qué se rechaza: el vendedor tiene que poder explicárselo al cliente', 422);
    }

    const patch: any = { status, reviewed_by: userId, updated_at: new Date().toISOString() };
    patch.reject_reason = status === 'rechazada' ? String(body.reject_reason).trim() : null;
    if (status === 'entregada') {
      patch.delivered_at = new Date().toISOString();
      if (body?.demo_tenant_id) patch.demo_tenant_id = body.demo_tenant_id;
      if (body?.demo_user) patch.demo_user = String(body.demo_user).trim();
      if (body?.demo_password) patch.demo_password = String(body.demo_password).trim();
      // Vencimiento: si no lo mandan, se calcula con los días pedidos.
      if (body?.expires_on) patch.expires_on = body.expires_on;
      else {
        const { data: r } = await db.from('demo_requests')
          .select('days').eq('id', c.req.param('id')).eq('tenant_id', tenantId).maybeSingle();
        const d = new Date();
        d.setDate(d.getDate() + (Number((r as any)?.days) || 15));
        patch.expires_on = d.toISOString().slice(0, 10);
      }
    }

    const { data, error } = await db.from('demo_requests').update(patch)
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId).select('*').single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

demoRequests.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const manager = await isManager(c);
    const { data: prev } = await db.from('demo_requests')
      .select('requested_by, status').eq('id', c.req.param('id')).eq('tenant_id', tenantId).maybeSingle();
    if (!prev) return fail(c, 'Solicitud no encontrada', 404);
    // El vendedor puede retirar SU solicitud mientras nadie la revisó.
    if (!manager && (String((prev as any).requested_by ?? '') !== userId || (prev as any).status !== 'pendiente')) {
      return fail(c, 'Solo podés borrar tus solicitudes que siguen pendientes', 403);
    }
    const { error } = await db.from('demo_requests').delete()
      .eq('id', c.req.param('id')).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default demoRequests;
