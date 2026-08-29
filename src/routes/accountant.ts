import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { alanube, AlanubeError, tenantAlanubeToken } from '../services/alanube.js';
import {
  buildAlanubeCompanyPayload, validateEmisorForAlanube, resolveCert, getMainCompanyInfo,
} from './admin.js';
import { createGroupClient, AddClientSchema } from './tenantGroups.js';

/**
 * Portal del CONTADOR.
 *
 * Un contador lleva la facturación electrónica de varios negocios: les carga la
 * llave criptográfica (.p12), completa los datos del emisor y vigila cuántos
 * comprobantes le quedan a cada uno.
 *
 * Su cartera son los negocios a los que tiene acceso en `user_tenants` — el
 * MISMO mecanismo de las sucursales — así que entra a cada uno con el selector de
 * empresa que ya existe. Esta vista le da lo que le falta: el estado de la FE de
 * TODOS sus clientes en una sola pantalla, sin entrar uno por uno.
 */
const accountant = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const FE_CERT_BUCKET = 'fe-certificates';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * La cartera del contador son sus `user_tenants`: el MISMO mecanismo con el que
 * un usuario cambia de sucursal. Así el contador entra a cada negocio con el
 * selector que ya existe, y no hay una segunda lista de permisos que mantener
 * (ni que se desincronice con la primera).
 */
async function assertClient(userId: string, tenantId: string): Promise<boolean> {
  const { data } = await db.from('user_tenants')
    .select('user_id').eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle();
  if (data) return true;
  // También vale si es el dueño directo del negocio.
  const { data: t } = await db.from('tenants')
    .select('owner_id').eq('id', tenantId).maybeSingle();
  return (t as any)?.owner_id === userId;
}

/** Bolsa de comprobantes FE de un negocio: incluidos, usados y disponibles. */
async function quotaFor(tenantId: string, cfg: any) {
  const included = Number(cfg?.fe_included_docs ?? 0);
  if (included <= 0) return cfg?.enabled ? { unlimited: true } : null;

  let start: string = cfg.fe_quota_start ?? '';
  if (!start) {
    const { data: t } = await db.from('tenants').select('created_at').eq('id', tenantId).maybeSingle();
    start = (t as any)?.created_at ?? new Date().toISOString();
  }
  // Los RECHAZADOS no consumen bolsa: no existen ante Hacienda.
  const failed = (s: any) => s === 'rejected' || s === 'error';
  let sel: any = await db.from('invoices')
    .select('fe_clave, fe_status, fe_nc_clave, fe_nc_status, fe_nd_clave, fe_nd_status')
    .eq('tenant_id', tenantId).gte('created_at', start)
    .or('fe_clave.not.is.null,fe_nc_clave.not.is.null,fe_nd_clave.not.is.null');
  if (sel.error) {
    sel = await db.from('invoices').select('fe_clave, fe_status')
      .eq('tenant_id', tenantId).gte('created_at', start).not('fe_clave', 'is', null);
  }
  let used = 0;
  for (const r of (sel.data ?? []) as any[]) {
    if (r.fe_clave && !failed(r.fe_status)) used++;
    if (r.fe_nc_clave && !failed(r.fe_nc_status)) used++;
    if (r.fe_nd_clave && !failed(r.fe_nd_status)) used++;
  }
  return {
    included, used,
    available: included - used,
    quota_start: start,
    expires_at: new Date(new Date(start).getTime() + YEAR_MS).toISOString(),
  };
}

/**
 * Comprobantes emitidos: totales, del mes en curso y rechazados.
 *
 * El total es lo que consume la bolsa; los rechazados son la alarma — no cuentan
 * ante Hacienda y normalmente significan que algo está mal configurado.
 */
async function feCounters(tenantId: string) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data } = await db.from('invoices')
    .select('fe_clave, fe_status, fe_nc_clave, fe_nd_clave, created_at')
    .eq('tenant_id', tenantId).not('fe_clave', 'is', null);
  const rows = (data ?? []) as any[];
  const accepted = rows.filter(r => r.fe_status === 'accepted').length;
  const rejected = rows.filter(r => r.fe_status === 'rejected' || r.fe_status === 'error').length;
  return {
    total: rows.length,
    accepted,
    rejected,
    pending: rows.length - accepted - rejected,
    this_month: rows.filter(r => String(r.created_at ?? '') >= monthStart).length,
    credit_notes: rows.filter(r => r.fe_nc_clave).length,
    debit_notes: rows.filter(r => r.fe_nd_clave).length,
  };
}

/** Qué le falta a un emisor para poder emitir. Es la lista de tareas del contador. */
function missingFields(cfg: any, hasCert: boolean): string[] {
  const m: string[] = [];
  const prod = String(cfg?.environment ?? 'production') !== 'sandbox';
  if (!String(cfg?.emisor_identification ?? '').trim()) m.push('Cédula del emisor');
  if (!String(cfg?.emisor_name ?? '').trim()) m.push('Nombre / razón social');
  if (!String(cfg?.economic_activity_code ?? '').trim()) m.push('Actividad económica');
  if (!String(cfg?.emisor_email ?? '').trim()) m.push('Correo del emisor');
  if (!String(cfg?.emisor_address ?? '').trim()) m.push('Dirección (otras señas)');
  if (!hasCert) m.push('Certificado .p12');
  const atvUser = (prod ? cfg?.atv_username_production : cfg?.atv_username_sandbox) || cfg?.atv_username;
  const atvPass = (prod ? cfg?.atv_password_production : cfg?.atv_password_sandbox) || cfg?.atv_password;
  if (!String(atvUser ?? '').trim()) m.push('Usuario de API de ATV');
  if (!String(atvPass ?? '').trim()) m.push('Contraseña de API de ATV');
  const p12Pass = (prod ? cfg?.p12_password_production : cfg?.p12_password_sandbox)
    || (prod ? cfg?.hacienda_pin_production : cfg?.hacienda_pin_sandbox)
    || cfg?.p12_password || cfg?.hacienda_pin;
  if (!String(p12Pass ?? '').trim()) m.push('PIN del certificado');
  return m;
}

/**
 * Da de alta (o actualiza) la empresa del cliente en Alanube.
 *
 * El contador no debería tener que acordarse de este paso: en cuanto los datos
 * del emisor y el certificado están completos, se hace solo al guardar. Es
 * idempotente — si la empresa ya existe con esa misma cédula, la actualiza.
 */
export async function ensureAlanubeCompany(tenantId: string): Promise<{
  ok: boolean; company_id?: string | null; message: string; missing?: string[];
}> {
  const { data: row } = await db.from('settings').select('config')
    .eq('tenant_id', tenantId).eq('type', 'electronic-invoice').maybeSingle();
  const cfg: Record<string, any> = { ...((row as any)?.config ?? {}) };

  // Alta de la empresa en Alanube.
  if (cfg.fe_provider !== 'alanube') {
    return { ok: false, message: 'El proveedor no es Alanube: no hay empresa que registrar.' };
  }

  const env = String(cfg.environment ?? 'production') === 'sandbox' ? 'sandbox' : 'production';
  const problems = validateEmisorForAlanube(cfg, env);
  const cert = resolveCert(cfg);
  if (!cert) problems.unshift('Certificado .p12');
  if (problems.length || !cert) {
    return { ok: false, message: 'Faltan datos para registrar la empresa.', missing: problems };
  }

  const { data: file, error: dlErr } = await db.storage.from('fe-certificates').download(cert.path);
  if (dlErr || !file) return { ok: false, message: `No se pudo leer el certificado: ${dlErr?.message ?? 'vacío'}` };
  const p12Base64 = Buffer.from(await file.arrayBuffer()).toString('base64');

  const client = alanube.forEnv(cfg.environment, tenantAlanubeToken(cfg, env as any));
  const payload = buildAlanubeCompanyPayload(cfg, p12Base64, client.env);
  const myCedula = String(cfg.emisor_identification ?? '').replace(/\D/g, '');

  let result: any;
  let updated = false;
  try {
    result = await client.createCompany(payload);
  } catch (e: any) {
    const already = e instanceof AlanubeError
      && (e.status === 400 || e.status === 409)
      && /already has (a )?main company|main company/i.test(String(e?.message ?? ''));
    if (!already) {
      return { ok: false, message: e?.message ?? 'Alanube rechazó el alta de la empresa.' };
    }
    // La cuenta ya tiene su empresa principal. Solo se actualiza si es la MISMA
    // cédula: pisar la de otro contribuyente dejaría a los dos emitiendo mal.
    const main = await getMainCompanyInfo(client);
    if (!main.id) {
      return { ok: true, company_id: null,
        message: 'La cuenta ya tiene su empresa principal y no se pudo ubicar su id. La emisión la usa igual.' };
    }
    if (main.cedula && myCedula && main.cedula.replace(/^0+/, '') !== myCedula.replace(/^0+/, '')) {
      return { ok: false, message:
        `Esta cuenta de Alanube ya está ocupada por la cédula ${main.cedula}, distinta a la de este cliente `
        + `(${myCedula}). Cada emisor necesita su propia cuenta o registrarse como empresa asociada.` };
    }
    const upd = { ...payload }; delete (upd as any).type;
    result = await client.updateCompany(String(main.id), upd);
    if (!result?.id) result = { ...result, id: main.id };
    updated = true;
  }

  const companyId = result?.id ?? result?.companyId ?? result?.company?.id ?? null;
  cfg.alanube_env = client.env;
  cfg.alanube_registered_at = new Date().toISOString();
  if (companyId) {
    cfg.alanube_company_id = companyId;
    if (client.env === 'sandbox') cfg.alanube_company_id_sandbox = companyId;
    else cfg.alanube_company_id_production = companyId;
  }
  await db.from('settings').upsert({
    tenant_id: tenantId, type: 'electronic-invoice', config: cfg, updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,type' });

  return {
    ok: true, company_id: companyId,
    message: updated ? 'Empresa ACTUALIZADA en Alanube.' : 'Empresa creada en Alanube.',
  };
}

// POST /clients/:id/alanube — crea o actualiza la empresa del cliente a pedido.
accountant.post('/clients/:id/alanube', async (c) => {
  try {
    const userId = c.get('userId');
    const id = c.req.param('id');
    if (!(await assertClient(userId, id))) return fail(c, 'Ese negocio no está en tu cartera', 403);
    const r = await ensureAlanubeCompany(id);
    return r.ok ? ok(c, r) : fail(c, r.message + (r.missing?.length ? `\n• ${r.missing.join('\n• ')}` : ''), 422);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * El grupo donde vive la cartera del contador.
 *
 * Es el mismo mecanismo de las sucursales (`tenant_groups` + `tenant_group_members`),
 * solo que con kind='accounting' para que las ventas de sus clientes NO se sumen
 * entre sí. Si el contador todavía no tiene grupo, se le crea acá: obligarlo a
 * pasar por el Panel Admin para poder dar de alta a su primer cliente era
 * justamente lo que había que quitarle de encima.
 */
async function accountantGroupId(userId: string): Promise<string> {
  const { data: existing } = await db.from('tenant_groups')
    .select('id, kind').eq('owner_id', userId).order('created_at', { ascending: true });
  const rows = (existing ?? []) as Array<{ id: string; kind?: string }>;
  const acc = rows.find(g => g.kind === 'accounting') ?? rows[0];
  if (acc) return acc.id;

  const { data: u } = await db.from('users').select('full_name, email').eq('id', userId).maybeSingle();
  const who = (u as any)?.full_name || String((u as any)?.email ?? '').replace('@nexoerp.local', '') || 'contador';
  const { data: created, error } = await db.from('tenant_groups')
    .insert({ name: `Clientes de ${who}`, owner_id: userId, kind: 'accounting' })
    .select('id').single();
  if (error) throw new Error(error.message);
  return created.id as string;
}

// POST /clients — el contador da de alta un cliente nuevo.
// Crea el negocio, lo mete en su cartera y guarda sus datos de Hacienda. El
// usuario del cliente no se toca desde acá (ver comentario abajo).
accountant.post('/clients', async (c) => {
  try {
    const userId = c.get('userId');
    const parsed = AddClientSchema.safeParse(await c.req.json());
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const groupId = await accountantGroupId(userId);
    // El contador NO crea usuarios: solo carga los datos del negocio. Las
    // credenciales con las que el cliente entra las da el administrador, que es
    // quien responde por los accesos.
    const r = await createGroupClient(userId, groupId, { ...parsed.data, access: undefined });
    if (!r.ok) return fail(c, r.message ?? 'No se pudo crear el cliente', r.status ?? 500);

    // Con los datos ya cargados, el alta en Alanube se intenta sola. Sin
    // certificado todavía no va a poder, y eso está bien: se reintenta al subirlo.
    const sync = r.tenant_id ? await ensureAlanubeCompany(r.tenant_id).catch(() => null) : null;
    return ok(c, { ...r, alanube: sync }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /clients — los negocios que lleva el contador, con su estado de FE, lo que
// falta configurar y cuántos comprobantes le quedan.
accountant.get('/clients', async (c) => {
  try {
    const userId = c.get('userId');
    // Mismos negocios que ve el selector de empresa (user_tenants) + los propios.
    const { data: links } = await db.from('user_tenants')
      .select('tenant_id').eq('user_id', userId);
    const { data: owned } = await db.from('tenants').select('id').eq('owner_id', userId);
    const ids = [...new Set([
      ...(links ?? []).map((r: any) => r.tenant_id),
      ...(owned ?? []).map((r: any) => r.id),
    ])];
    if (ids.length === 0) return ok(c, []);

    const [{ data: tenants }, { data: settings }, { data: general }] = await Promise.all([
      db.from('tenants').select('id, name, status, created_at, plan_id').in('id', ids),
      db.from('settings').select('tenant_id, config').eq('type', 'electronic-invoice').in('tenant_id', ids),
      db.from('settings').select('tenant_id, config').eq('type', 'general').in('tenant_id', ids),
    ]);
    const cfgByTenant = new Map<string, any>();
    for (const s of (settings ?? []) as any[]) cfgByTenant.set(s.tenant_id, s.config ?? {});
    const genByTenant = new Map<string, any>();
    for (const s of (general ?? []) as any[]) genByTenant.set(s.tenant_id, s.config ?? {});

    // Plan SaaS y plan FE: es lo que el contador necesita para saber qué le puede
    // ofrecer al cliente y por qué se le está cobrando.
    const planIds = Array.from(new Set((tenants ?? []).map((t: any) => t.plan_id).filter(Boolean)));
    const planById = new Map<string, any>();
    if (planIds.length) {
      const { data: plans } = await db.from('subscription_plans')
        .select('id, name, price, billing_cycle').in('id', planIds);
      for (const p of (plans ?? []) as any[]) planById.set(p.id, p);
    }
    const fePlanByTenant = new Map<string, any>();
    try {
      const { data: fePlans } = await db.from('tenant_fe_plans')
        .select('tenant_id, active, current_usage, fe_plan:fe_plans(id, name, monthly_quota, monthly_price)')
        .in('tenant_id', ids);
      for (const r of (fePlans ?? []) as any[]) {
        // PostgREST devuelve el embed como objeto o como arreglo según la relación.
        fePlanByTenant.set(r.tenant_id, { ...r, fe_plan: Array.isArray(r.fe_plan) ? r.fe_plan[0] : r.fe_plan });
      }
    } catch (e: any) { console.warn('[accountant] fe plans:', e?.message); }

    // Vencimiento de la suscripción: un negocio vencido no debería sorprender al
    // contador el día que deja de facturar.
    const subByTenant = new Map<string, any>();
    try {
      const { data: subs } = await db.from('subscriptions')
        .select('tenant_id, status, ends_at, created_at').in('tenant_id', ids)
        .order('created_at', { ascending: false });
      for (const r of (subs ?? []) as any[]) if (!subByTenant.has(r.tenant_id)) subByTenant.set(r.tenant_id, r);
    } catch (e: any) { console.warn('[accountant] subs:', e?.message); }

    const out = [];
    for (const t of (tenants ?? []) as any[]) {
      const cfg = cfgByTenant.get(t.id) ?? {};
      const gen = genByTenant.get(t.id) ?? {};
      const plan = t.plan_id ? planById.get(t.plan_id) : null;
      const fePlan = fePlanByTenant.get(t.id) ?? null;
      const sub = subByTenant.get(t.id) ?? null;
      const env = String(cfg.environment ?? 'production') === 'sandbox' ? 'sandbox' : 'production';
      const cert = (env === 'sandbox' ? cfg.certificate_sandbox : cfg.certificate_production) ?? cfg.certificate;
      const missing = missingFields(cfg, !!cert?.path);
      out.push({
        tenant_id: t.id,
        name: t.name,
        status: t.status,
        fe_enabled: cfg.enabled !== false && Object.keys(cfg).length > 0,
        fe_provider: cfg.fe_provider ?? null,
        environment: env,
        emisor_name: cfg.emisor_name ?? null,
        emisor_identification: cfg.emisor_identification ?? null,
        has_certificate: !!cert?.path,
        certificate_name: cert?.filename ?? null,
        missing,
        ready: missing.length === 0,
        quota: await quotaFor(t.id, cfg),
        // ── Datos del negocio (los que el contador edita) ──
        business: {
          business_name: gen.businessName ?? t.name,
          phone: gen.phone ?? null,
          email: gen.email ?? null,
          address: gen.address ?? null,
          identification: gen.identification ?? cfg.emisor_identification ?? null,
        },
        created_at: t.created_at ?? null,
        // ── Plan ──
        plan: plan ? {
          id: plan.id, name: plan.name,
          price: Number(plan.price ?? 0),
          billing_cycle: plan.billing_cycle ?? 'monthly',
        } : null,
        subscription: sub ? { status: sub.status, ends_at: sub.ends_at ?? null } : null,
        fe_plan: fePlan?.fe_plan ? {
          id: fePlan.fe_plan.id,
          name: fePlan.fe_plan.name,
          monthly_quota: Number(fePlan.fe_plan.monthly_quota ?? 0),
          monthly_price: Number(fePlan.fe_plan.monthly_price ?? 0),
          current_usage: Number(fePlan.current_usage ?? 0),
          active: fePlan.active !== false,
        } : null,
        // ── Contador de comprobantes emitidos ──
        counters: await feCounters(t.id),
      });
    }
    out.sort((a, b) => Number(a.ready) - Number(b.ready) || a.name.localeCompare(b.name));
    return ok(c, out);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /clients/:id/business — datos del negocio (nombre, contacto, dirección).
//
// El contador los corrige sin tener que entrar al negocio ni pedirle nada al
// administrador: es exactamente lo que hoy obliga a dar la vuelta por el Panel.
accountant.put('/clients/:id/business', async (c) => {
  try {
    const userId = c.get('userId');
    const id = c.req.param('id');
    if (!(await assertClient(userId, id))) return fail(c, 'Ese negocio no está en tu cartera', 403);

    const body = await c.req.json().catch(() => ({} as any));
    const b = (body?.business ?? body) as Record<string, any>;

    // El nombre vive en `tenants` (es el que se ve en el selector de empresa) y
    // en settings.general (el que sale en los tiquetes). Se mantienen iguales.
    const name = String(b.business_name ?? '').trim();
    if (name) {
      const { error } = await db.from('tenants').update({ name }).eq('id', id);
      if (error) throw new Error(error.message);
    }

    const { data: row } = await db.from('settings').select('config')
      .eq('tenant_id', id).eq('type', 'general').maybeSingle();
    const cfg: Record<string, any> = { ...((row as any)?.config ?? {}) };
    if (name) cfg.businessName = name;
    for (const k of ['phone', 'email', 'address', 'identification'] as const) {
      if (b[k] !== undefined) cfg[k] = b[k] === '' ? null : b[k];
    }
    const { error: sErr } = await db.from('settings').upsert({
      tenant_id: id, type: 'general', config: cfg, updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' });
    if (sErr) throw new Error(sErr.message);

    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /clients/:id/fe-config — datos del emisor de UN cliente.
accountant.get('/clients/:id/fe-config', async (c) => {
  try {
    const userId = c.get('userId');
    const id = c.req.param('id');
    if (!(await assertClient(userId, id))) return fail(c, 'Ese negocio no está en tu cartera', 403);
    const { data } = await db.from('settings').select('config')
      .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    // Nunca se devuelve el contenido del .p12, solo su metadata.
    const cfg: any = { ...((data as any)?.config ?? {}) };
    for (const k of ['certificate', 'certificate_production', 'certificate_sandbox']) {
      if (cfg[k]?.content) delete cfg[k].content;
    }
    return ok(c, cfg);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// PUT /clients/:id/fe-config — el contador completa los datos del emisor.
accountant.put('/clients/:id/fe-config', async (c) => {
  try {
    const userId = c.get('userId');
    const id = c.req.param('id');
    if (!(await assertClient(userId, id))) return fail(c, 'Ese negocio no está en tu cartera', 403);
    const body = await c.req.json().catch(() => ({} as any));
    const fe = body?.fe ?? body;

    // Campos que el contador NO puede tocar. Los primeros son comerciales (los
    // define quien vende el plan). Los del certificado son de TRIBU: la llave
    // criptográfica y su PIN los carga el administrador, no el contador.
    const BLOCKED = [
      'fe_included_docs', 'fe_extra_fee', 'fe_quota_start', 'fe_plan_id',
      'certificate', 'certificate_production', 'certificate_sandbox',
      'p12_password', 'p12_password_production', 'p12_password_sandbox',
      'hacienda_pin', 'hacienda_pin_production', 'hacienda_pin_sandbox',
    ];
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(fe ?? {})) {
      if (!BLOCKED.includes(k)) clean[k] = v;
    }

    const { data: prev } = await db.from('settings').select('config')
      .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const merged = { ...((prev?.config as any) ?? {}), ...clean };
    const { error } = await db.from('settings').upsert({
      tenant_id: id, type: 'electronic-invoice', config: merged,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' });
    if (error) throw new Error(error.message);

    // Con los datos completos, la empresa se registra en Alanube sin que el
    // contador tenga que acordarse de un paso aparte. Si falta algo, se informa
    // pero NO se pierde lo que acaba de guardar.
    const sync = await ensureAlanubeCompany(id).catch((e: any) => ({
      ok: false, message: e?.message ?? 'Error al registrar en Alanube',
    } as any));
    return ok(c, { ok: true, alanube: sync });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /clients/:id/certificate — sube la llave criptográfica (.p12).
// body: { file_base64, filename, p12_password, environment? }
accountant.post('/clients/:id/certificate', async (c) => {
  try {
    const userId = c.get('userId');
    const id = c.req.param('id');
    if (!(await assertClient(userId, id))) return fail(c, 'Ese negocio no está en tu cartera', 403);

    // La llave criptográfica de TRIBU la carga el ADMINISTRADOR, no el contador:
    // es el archivo con el que se firma a nombre del contribuyente y no debe
    // pasar por más manos de las necesarias. Se bloquea acá y no solo en la
    // pantalla, para que ocultar el botón no sea toda la protección.
    const { data: me } = await db.from('users').select('role').eq('id', userId).maybeSingle();
    if ((me as any)?.role === 'contador') {
      return fail(c, 'La llave criptográfica (.p12) la carga el administrador.', 403);
    }
    const body = await c.req.json().catch(() => ({} as any));
    const { file_base64, filename, p12_password } = body ?? {};
    if (!file_base64) return fail(c, 'Falta el archivo del certificado (.p12)', 422);

    const buf = Buffer.from(String(file_base64).replace(/^data:[^;]*;base64,/, ''), 'base64');
    if (buf.length === 0) return fail(c, 'El archivo del certificado está vacío', 422);

    const { data: row } = await db.from('settings').select('config')
      .eq('tenant_id', id).eq('type', 'electronic-invoice').maybeSingle();
    const cfg: Record<string, any> = { ...((row as any)?.config ?? {}) };
    const env = String(body?.environment ?? cfg.environment ?? 'production') === 'sandbox'
      ? 'sandbox' : 'production';

    const path = `${id}/${env}-${Date.now()}.p12`;
    const { error: upErr } = await db.storage.from(FE_CERT_BUCKET)
      .upload(path, buf, { contentType: 'application/x-pkcs12', upsert: true });
    if (upErr) throw new Error(`No se pudo guardar el certificado: ${upErr.message}`);

    const meta = { path, filename: filename ?? 'certificado.p12', uploaded_at: new Date().toISOString() };
    cfg[env === 'sandbox' ? 'certificate_sandbox' : 'certificate_production'] = meta;
    if (p12_password) {
      cfg[env === 'sandbox' ? 'p12_password_sandbox' : 'p12_password_production'] = p12_password;
    }
    const { error } = await db.from('settings').upsert({
      tenant_id: id, type: 'electronic-invoice', config: cfg, updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' });
    if (error) throw new Error(error.message);
    // El certificado suele ser lo último que falta: se reintenta el alta.
    const sync = await ensureAlanubeCompany(id).catch(() => null);
    return ok(c, { ok: true, environment: env, certificate: meta, alanube: sync });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /clients/:id/invoices — comprobantes del cliente (para revisar y descargar).
accountant.get('/clients/:id/invoices', async (c) => {
  try {
    const userId = c.get('userId');
    const id = c.req.param('id');
    if (!(await assertClient(userId, id))) return fail(c, 'Ese negocio no está en tu cartera', 403);
    const from = c.req.query('from');
    const to = c.req.query('to');
    let q = db.from('invoices')
      .select('id, invoice_number, customer_name, subtotal, tax_amount, total, issued_at, '
        + 'document_type, status, fe_clave, fe_status, fe_error')
      .eq('tenant_id', id).order('issued_at', { ascending: false }).limit(2000);
    if (from) q = q.gte('issued_at', from);
    if (to)   q = q.lte('issued_at', to);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// ── Cartera del contador (solo super-admin) ─────────────────────────────────
// Se escribe en `user_tenants`, igual que al dar acceso a una sucursal: el
// contador pasa a ver ese negocio en el selector de empresa y puede trabajarlo.
/**
 * Código para enlazar un negocio ya existente con su contador.
 *
 * Lo genera EL NEGOCIO, no el contador: enganchar la cartera de un contador a un
 * negocio cualquiera le daría acceso a la facturación de gente que no es su
 * cliente. Se dicta por teléfono, dura poco y se usa una sola vez.
 */
const LINK_CODE_TTL_MS = 72 * 60 * 60 * 1000;   // 3 días: alcanza para pasarlo y usarlo

/** Código corto y dictable: sin 0/O ni 1/I, que se confunden al leerlos. */
function nuevoCodigo(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

// POST /link-code — el NEGOCIO genera el código para dárselo a su contador.
accountant.post('/link-code', async (c) => {
  try {
    const role = String(c.get('role') ?? '');
    if (!['owner', 'admin', 'gerente'].includes(role)) {
      return fail(c, 'Solo el dueño o el gerente pueden autorizar a un contador', 403);
    }
    const tenantId = c.get('tenantId');
    if (!tenantId) return fail(c, 'Sin negocio asignado', 403);

    const code = nuevoCodigo();
    const expires_at = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
    const { data, error } = await db.from('accountant_link_codes')
      .insert({ tenant_id: tenantId, code, created_by: c.get('userId'), expires_at })
      .select('code, expires_at').single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /link — el CONTADOR canjea el código y suma el negocio a su cartera.
accountant.post('/link', async (c) => {
  try {
    const userId = c.get('userId');
    const raw = await c.req.json().catch(() => ({} as any));
    const code = String(raw?.code ?? '').trim().toUpperCase();
    if (!code) return fail(c, 'Escribí el código que te dio el negocio', 422);

    const { data: fila } = await db.from('accountant_link_codes')
      .select('*').ilike('code', code).maybeSingle();
    // Mismo mensaje para «no existe» y «ya se usó»: distinguirlos le diría a
    // quien prueba códigos al azar cuáles existen.
    if (!fila) return fail(c, 'Ese código no es válido o ya se usó', 404);
    if ((fila as any).used_at) return fail(c, 'Ese código no es válido o ya se usó', 409);
    if (new Date((fila as any).expires_at).getTime() < Date.now()) {
      return fail(c, 'Ese código ya venció. Pedile uno nuevo al negocio.', 410);
    }

    const tenantId = (fila as any).tenant_id as string;
    const { error: upErr } = await db.from('user_tenants').upsert({
      user_id: userId, tenant_id: tenantId, role: 'staff', is_default: false,
    }, { onConflict: 'user_id,tenant_id' });
    if (upErr) throw new Error(upErr.message);

    // Se quema el código: uno solo por enlace, para que no circule después.
    await db.from('accountant_link_codes')
      .update({ used_at: new Date().toISOString(), used_by: userId })
      .eq('id', (fila as any).id);

    const { data: t } = await db.from('tenants')
      .select('name').eq('id', tenantId).maybeSingle();
    return ok(c, { tenant_id: tenantId, business_name: (t as any)?.name ?? null }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

accountant.post('/assign', async (c) => {
  try {
    const role = c.get('role');
    if (!['owner', 'admin'].includes(String(role))) return fail(c, 'forbidden', 403);
    const body = await c.req.json().catch(() => ({} as any));
    const accountantId = String(body?.accountant_id ?? '').trim();
    const tenantId = String(body?.tenant_id ?? '').trim();
    if (!accountantId || !tenantId) return fail(c, 'Falta accountant_id o tenant_id', 422);
    const { error } = await db.from('user_tenants').upsert({
      user_id: accountantId, tenant_id: tenantId, role: 'staff', is_default: false,
    }, { onConflict: 'user_id,tenant_id' });
    if (error) throw new Error(error.message);
    return ok(c, { ok: true }, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

accountant.delete('/assign', async (c) => {
  try {
    const role = c.get('role');
    if (!['owner', 'admin'].includes(String(role))) return fail(c, 'forbidden', 403);
    const body = await c.req.json().catch(() => ({} as any));
    const { error } = await db.from('user_tenants').delete()
      .eq('user_id', body?.accountant_id).eq('tenant_id', body?.tenant_id);
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default accountant;
