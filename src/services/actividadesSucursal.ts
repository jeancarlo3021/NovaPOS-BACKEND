import { db } from '../db/client.js';
import { normalizarActividad, siguienteSucursal, sucursalesDeActividad } from './feCompartida.js';

/**
 * Alta de una ACTIVIDAD económica como sucursal (ver services/feCompartida).
 *
 * Vive fuera de las rutas porque se usa desde dos lados: el botón «Agregar
 * actividad» del panel de grupos, y el guardado de los datos de FE, que la crea
 * sola cuando el negocio anota una actividad más.
 */

/** Error con el status HTTP que corresponde (validación = 4xx, no 500). */
export class ErrorDeActividad extends Error {
  constructor(mensaje: string, public status: 409 | 422 = 422) { super(mensaje); }
}

/** Crea un negocio nuevo (activo, con suscripción si trae plan). Devuelve su id. */
export async function crearNegocio(
  nt: { name: string; plan_id?: string | null; is_demo?: boolean },
  userId: string,
): Promise<string> {
  // schema_name es NOT NULL en tenants. Generamos uno único por tenant
  // siguiendo el patrón del edge function admin-create-owner (`tenant_<uuid>`).
  const tenantUuid = (globalThis.crypto as any)?.randomUUID?.()
    ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const schemaName = `tenant_${String(tenantUuid).replace(/-/g, '_')}`;

  const { data: created, error: tErr } = await db.from('tenants')
    .insert({
      name:        nt.name,
      owner_id:    userId,
      is_demo:     nt.is_demo ?? false,
      plan_id:     nt.plan_id ?? null,
      status:      'active',
      schema_name: schemaName,
    })
    .select('id').single();
  if (tErr) throw new Error(tErr.message);
  const tenantId = created.id as string;

  // Si tiene plan, crear suscripción asociada para que aparezca con su
  // fecha de vencimiento en /admin/owners.
  if (nt.plan_id) {
    try {
      const { data: planRow } = await db.from('subscription_plans')
        .select('billing_cycle').eq('id', nt.plan_id).maybeSingle();
      const cycleDays = (planRow?.billing_cycle ?? 'monthly').toLowerCase() === 'yearly' ? 365 : 30;
      const endsAt = new Date(Date.now() + cycleDays * 86400000).toISOString();

      const { data: subData } = await db.from('subscriptions')
        .insert({
          tenant_id: tenantId,
          plan_id:   nt.plan_id,
          status:    'active',
          ends_at:   endsAt,
          auto_renew: true,
        })
        .select('id').single();
      if (subData?.id) {
        await db.from('tenants').update({ subscription_id: subData.id }).eq('id', tenantId);
      }
    } catch (e: any) {
      console.warn('[branches] no se pudo crear suscripción:', e?.message);
    }
  }
  return tenantId;
}

/**
 * Grupo del negocio principal. Si no tiene, se crea con él como matriz.
 *
 * Una actividad es una sucursal de la sociedad: tiene que quedar ligada al
 * principal para que el dueño cambie de una a otra, vea los reportes juntos y
 * herede el plan. Pedirle que arme el grupo antes era un paso que nadie sabe
 * que existe.
 */
export async function grupoDelPrincipal(principalId: string, userId: string): Promise<string> {
  const { data: miembro } = await db.from('tenant_group_members')
    .select('group_id').eq('tenant_id', principalId).maybeSingle();
  if ((miembro as any)?.group_id) return String((miembro as any).group_id);

  const { data: t } = await db.from('tenants').select('name, owner_id').eq('id', principalId).maybeSingle();
  const ownerId = String((t as any)?.owner_id ?? userId);
  const base = { name: String((t as any)?.name ?? 'Sociedad'), owner_id: ownerId, notes: 'Creado al agregar una actividad económica' };
  let { data: g, error } = await db.from('tenant_groups').insert({ ...base, kind: 'branches' }).select('id').single();
  // Resiliente: si la migración 81 no corrió, se crea sin `kind`.
  if (error && /kind/i.test(error.message)) {
    ({ data: g, error } = await db.from('tenant_groups').insert(base).select('id').single());
  }
  if (error || !g) throw new Error(`No se pudo crear el grupo de la sociedad: ${error?.message ?? 'sin respuesta'}`);

  const { error: mErr } = await db.from('tenant_group_members')
    .insert({ group_id: (g as any).id, tenant_id: principalId, role: 'main' });
  if (mErr) throw new Error(mErr.message);
  await db.from('user_tenants').upsert(
    { user_id: ownerId, tenant_id: principalId, role: 'owner', is_default: true },
    { onConflict: 'user_id,tenant_id' });
  return String((g as any).id);
}

export interface AltaDeActividad {
  groupId: string;
  userId: string;
  principalId: string;
  actividad: any;
  /** Negocio existente que pasa a llevar la actividad; si no, se crea uno. */
  tenantId?: string | null;
  nuevo?: { name?: string; plan_id?: string | null; is_demo?: boolean } | null;
  fePlanId?: string | null;
}

/**
 * Crea (o convierte) el negocio de la actividad y lo liga al principal.
 * No actualiza Alanube ni copia productos: eso lo decide quien llama.
 */
export async function crearActividadComoSucursal(o: AltaDeActividad) {
  const { groupId, userId, principalId } = o;
  const actividad = normalizarActividad(o.actividad);
  if (!principalId) throw new ErrorDeActividad('Elegí el negocio principal, el que tiene los datos de facturación.');
  if (!actividad) {
    throw new ErrorDeActividad(`Código de actividad inválido («${String(o.actividad ?? '')}»). `
      + 'Va con el formato del catálogo de Hacienda, por ejemplo 4752.1.');
  }

  const { data: esMiembro } = await db.from('tenant_group_members')
    .select('tenant_id').eq('group_id', groupId).eq('tenant_id', principalId).maybeSingle();
  if (!esMiembro) throw new ErrorDeActividad('El negocio principal tiene que ser parte de este grupo.');

  const { data: filaPrincipal } = await db.from('settings').select('config')
    .eq('tenant_id', principalId).eq('type', 'electronic-invoice').maybeSingle();
  const principal: Record<string, any> = { ...((filaPrincipal as any)?.config ?? {}) };
  if (principal.fe_shared_from) {
    throw new ErrorDeActividad('Ese negocio ya es una actividad de otro. Elegí el negocio principal de la sociedad.');
  }
  const cedula = String(principal.emisor_identification ?? '').replace(/\D/g, '');
  if (!cedula) {
    throw new ErrorDeActividad('El negocio principal no tiene cédula en sus datos de facturación electrónica. '
      + 'Completalos primero: la actividad nueva factura con esos datos.');
  }

  // La misma actividad dos veces no es otra actividad: es una sucursal común.
  const existentes = await sucursalesDeActividad(principalId);
  const repetida = normalizarActividad(principal.economic_activity_code) === actividad
    ? principalId
    : existentes.find(x => normalizarActividad(x.config.economic_activity_code) === actividad)?.tenant_id;
  if (repetida) {
    const { data: t } = await db.from('tenants').select('name').eq('id', repetida).maybeSingle();
    throw new ErrorDeActividad(`«${(t as any)?.name ?? 'Otro negocio'}» ya factura con la actividad ${actividad}. `
      + 'Si es otro local de la misma actividad, agregalo como sucursal.', 409);
  }

  // Negocio: uno nuevo, o uno que ya existe (del grupo o sin grupo).
  let tenantId = o.tenantId || null;
  let creado = false;
  if (!tenantId) {
    const nombre = String(o.nuevo?.name ?? '').trim();
    if (nombre.length < 2) throw new ErrorDeActividad('Poné el nombre del negocio de esta actividad.');
    tenantId = await crearNegocio({ name: nombre, plan_id: o.nuevo?.plan_id ?? null, is_demo: !!o.nuevo?.is_demo }, userId);
    creado = true;
  }
  if (tenantId === principalId) throw new ErrorDeActividad('La actividad tiene que ir en un negocio distinto del principal.');

  // Si ese negocio ya emitía por su cuenta, no se le quita la config sin avisar.
  const { data: filaPropia } = await db.from('settings').select('config')
    .eq('tenant_id', tenantId).eq('type', 'electronic-invoice').maybeSingle();
  const propiaAnterior: Record<string, any> = (filaPropia as any)?.config ?? {};
  const cedulaPropia = String(propiaAnterior.emisor_identification ?? '').replace(/\D/g, '');
  if (!creado && cedulaPropia && cedulaPropia.replace(/^0+/, '') !== cedula.replace(/^0+/, '')) {
    throw new ErrorDeActividad('Ese negocio factura con OTRA cédula. Una actividad solo puede ser de la misma sociedad.');
  }

  // Grupo y acceso, igual que una sucursal.
  const { data: yaEnGrupo } = await db.from('tenant_group_members')
    .select('group_id').eq('tenant_id', tenantId).maybeSingle();
  if (yaEnGrupo && (yaEnGrupo as any).group_id !== groupId) {
    throw new ErrorDeActividad('Ese negocio pertenece a otro grupo.');
  }
  if (!yaEnGrupo) {
    const { error: linkErr } = await db.from('tenant_group_members')
      .insert({ group_id: groupId, tenant_id: tenantId, role: 'branch' });
    if (linkErr) throw new Error(linkErr.message);
  }
  const { data: ownerRow } = await db.from('tenant_groups').select('owner_id').eq('id', groupId).maybeSingle();
  const accesos = new Set<string>([userId]);
  if ((ownerRow as any)?.owner_id) accesos.add((ownerRow as any).owner_id);
  await db.from('user_tenants').upsert(
    [...accesos].map(uid => ({ user_id: uid, tenant_id: tenantId!, role: 'owner', is_default: false })),
    { onConflict: 'user_id,tenant_id' });

  /**
   * Config propia: SOLO lo de la actividad. Lo demás lo lee del principal
   * (services/feCompartida), así un cambio de certificado o de teléfono en la
   * sociedad llega a todas sus actividades sin copiar nada.
   */
  const sucursal = await siguienteSucursal(cedula);
  const propia: Record<string, any> = {
    fe_shared_from: principalId,
    economic_activity_code: actividad,
    sucursal,
    terminal: '1',
  };
  if (principal.default_document_type) propia.default_document_type = principal.default_document_type;
  if (!creado && Object.keys(propiaAnterior).length) propia.fe_config_anterior = propiaAnterior;
  const { error: cfgErr } = await db.from('settings').upsert({
    tenant_id: tenantId, type: 'electronic-invoice', config: propia,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,type' });
  if (cfgErr) throw new Error(cfgErr.message);

  if (o.fePlanId) {
    await db.from('tenant_fe_plans').upsert({ tenant_id: tenantId, fe_plan_id: o.fePlanId, active: true });
  }

  return { principalId, tenant_id: tenantId, creado, economic_activity_code: actividad, sucursal };
}

/**
 * Crea sola una sucursal por cada actividad de la lista que todavía no tiene
 * negocio.
 *
 * Mira TODA la lista, no solo lo agregado en este guardado: las actividades que
 * ya estaban anotadas antes de existir esta función tienen que crearse también,
 * y si no, parecía que no hacía nada.
 *
 * Lo que se quitó a propósito no vuelve: al desligar el negocio de una actividad
 * se anota en `actividades_sin_negocio` del principal. Si después la vuelven a
 * agregar a la lista, se toma como que ahora sí la quieren y se crea.
 *
 * No se crea para una actividad de otra sociedad (no tiene lista propia) ni sin
 * cédula (no tendría con qué facturar). Nunca hace fallar el guardado: lo que no
 * se pudo crear se devuelve como aviso.
 */
export async function crearActividadesNuevas(
  tenantId: string, anterior: Record<string, any>, actual: Record<string, any>, userId: string,
) {
  const creadas: Array<{ tenant_id: string; nombre: string; economic_activity_code: string; sucursal: string }> = [];
  const avisos: string[] = [];
  if (actual?.fe_shared_from) return { creadas, avisos };
  if (!String(actual?.emisor_identification ?? '').replace(/\D/g, '')) return { creadas, avisos };

  const lista = (cfg: any) => (Array.isArray(cfg?.economic_activities) ? cfg.economic_activities : [])
    .map(normalizarActividad).filter(Boolean) as string[];
  const antes = new Set(lista(anterior));
  const principalActual = normalizarActividad(actual?.economic_activity_code);
  const candidatas = [...new Set(lista(actual))].filter(a => a !== principalActual);
  if (candidatas.length === 0) return { creadas, avisos };

  // Descartadas a propósito, salvo que se hayan vuelto a agregar ahora.
  const { data: fila } = await db.from('settings').select('config')
    .eq('tenant_id', tenantId).eq('type', 'electronic-invoice').maybeSingle();
  const guardada: Record<string, any> = (fila as any)?.config ?? {};
  const descartadas = new Set<string>((Array.isArray(guardada.actividades_sin_negocio) ? guardada.actividades_sin_negocio : [])
    .map(normalizarActividad));
  const reagregadas = candidatas.filter(a => descartadas.has(a) && !antes.has(a));
  if (reagregadas.length) {
    const quedan = [...descartadas].filter(a => !reagregadas.includes(a));
    await db.from('settings').upsert({
      tenant_id: tenantId, type: 'electronic-invoice',
      config: { ...guardada, actividades_sin_negocio: quedan },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' });
    reagregadas.forEach(a => descartadas.delete(a));
  }

  // Las que ya tienen negocio no se tocan.
  const conNegocio = new Set((await sucursalesDeActividad(tenantId))
    .map(x => normalizarActividad(x.config.economic_activity_code)));
  const pendientes = candidatas.filter(a => !descartadas.has(a) && !conNegocio.has(a));
  if (pendientes.length === 0) return { creadas, avisos };

  let groupId: string;
  try { groupId = await grupoDelPrincipal(tenantId, userId); }
  catch (e: any) { avisos.push(e?.message ?? 'No se pudo ligar a un grupo.'); return { creadas, avisos }; }

  const { data: t } = await db.from('tenants').select('name, owner_id').eq('id', tenantId).maybeSingle();
  const base = String((t as any)?.name ?? 'Negocio').trim();
  // El negocio nuevo queda a nombre del dueño de la sociedad, no de quien guardó.
  const dueño = String((t as any)?.owner_id ?? userId);

  for (const actividad of pendientes) {
    try {
      const r = await crearActividadComoSucursal({
        groupId, userId: dueño, principalId: tenantId, actividad,
        nuevo: { name: `${base} · ${actividad}` },
      });
      creadas.push({ tenant_id: r.tenant_id!, nombre: `${base} · ${actividad}`, economic_activity_code: r.economic_activity_code, sucursal: r.sucursal });
    } catch (e: any) {
      if (!(e instanceof ErrorDeActividad && e.status === 409)) {
        avisos.push(`Actividad ${actividad}: ${e?.message ?? 'no se pudo crear'}`);
      }
    }
  }
  return { creadas, avisos };
}

/**
 * Al desligar el negocio de una actividad, se anota en el principal para que el
 * próximo guardado de los datos de FE no lo vuelva a crear.
 */
export async function recordarActividadSinNegocio(tenantId: string) {
  const { data: fila } = await db.from('settings').select('config')
    .eq('tenant_id', tenantId).eq('type', 'electronic-invoice').maybeSingle();
  const cfg: Record<string, any> = (fila as any)?.config ?? {};
  const principalId = String(cfg.fe_shared_from ?? '').trim();
  const actividad = normalizarActividad(cfg.economic_activity_code);
  if (!principalId || !actividad) return;
  const { data: fp } = await db.from('settings').select('config')
    .eq('tenant_id', principalId).eq('type', 'electronic-invoice').maybeSingle();
  const principal: Record<string, any> = (fp as any)?.config ?? {};
  const lista = new Set<string>(Array.isArray(principal.actividades_sin_negocio) ? principal.actividades_sin_negocio : []);
  lista.add(actividad);
  await db.from('settings').upsert({
    tenant_id: principalId, type: 'electronic-invoice',
    config: { ...principal, actividades_sin_negocio: [...lista] },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,type' });
}
