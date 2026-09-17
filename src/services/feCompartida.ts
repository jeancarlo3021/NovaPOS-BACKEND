import { db } from '../db/client.js';

/**
 * Una sociedad con VARIAS ACTIVIDADES económicas, llevada como sucursales.
 *
 * Una misma cédula jurídica puede tener, por ejemplo, una ferretería y un
 * taller. Hacienda las ve como un solo contribuyente, pero en el día a día son
 * dos negocios: inventario, cajas, reportes y cierres separados. Cada
 * comprobante tiene que declarar la actividad a la que corresponde la venta.
 *
 * Se resuelve igual que las sucursales: cada actividad es un negocio del grupo.
 * Lo que es de la SOCIEDAD —cédula, razón social, certificado, credenciales de
 * ATV, empresa en Alanube, contacto— vive en el negocio principal y la sucursal
 * lo lee de ahí, en vivo. Lo que es de la ACTIVIDAD queda en la sucursal:
 *
 *   · su código de actividad, que va en cada comprobante;
 *   · su número de sucursal ante Hacienda (002, 003…), que va dentro de la
 *     clave. Con el mismo número, las dos series chocarían: Hacienda rechaza
 *     con -99 el segundo comprobante que usa una numeración ya emitida;
 *   · sus consecutivos.
 *
 * La bolsa de comprobantes es de la sociedad: se cobra por razón social.
 *
 * La sucursal se marca con `fe_shared_from` = id del negocio principal.
 */
export const CAMPOS_DE_LA_ACTIVIDAD = [
  'fe_shared_from',
  'sucursal', 'terminal',
  'economic_activity_code', 'economic_activities',
  'default_document_type',
  'consecutivo_factura', 'consecutivo_tiquete', 'consecutivo_nc', 'consecutivo_nd',
  // La bolsa de comprobantes NO está acá: se cobra por razón social, así que
  // vive en el principal y la comparten todas sus actividades (ver razonSocialDe).
  'notify_phone',
] as const;

const esDeLaActividad = (k: string) => (CAMPOS_DE_LA_ACTIVIDAD as readonly string[]).includes(k);

async function leerConfig(tenantId: string): Promise<Record<string, any> | null> {
  const { data } = await db.from('settings').select('config')
    .eq('tenant_id', tenantId).eq('type', 'electronic-invoice').maybeSingle();
  return (data as any)?.config ?? null;
}

async function guardarConfig(tenantId: string, config: Record<string, any>) {
  const { error } = await db.from('settings').upsert({
    tenant_id: tenantId, type: 'electronic-invoice', config,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,type' });
  if (error) throw new Error(error.message);
}

/**
 * La config con la que factura el negocio.
 *
 * Para una sucursal de actividad, los datos de la sociedad salen del principal
 * y encima van los suyos. Si alguien cambia el certificado, o se crea la empresa
 * en Alanube después, la sucursal lo toma sin que haya que copiar nada.
 */
export function combinarConPrincipal(propia: Record<string, any>, principal: Record<string, any> | null) {
  if (!principal || !propia?.fe_shared_from) return propia;
  const combinada: Record<string, any> = {};
  for (const [k, v] of Object.entries(principal)) if (!esDeLaActividad(k)) combinada[k] = v;
  for (const [k, v] of Object.entries(propia)) if (esDeLaActividad(k)) combinada[k] = v;
  return combinada;
}

export async function configEfectiva(tenantId: string, propia?: Record<string, any> | null) {
  const cfg = propia ?? (await leerConfig(tenantId)) ?? {};
  const principalId = String(cfg.fe_shared_from ?? '').trim();
  if (!principalId || principalId === tenantId) return cfg;
  return combinarConPrincipal(cfg, await leerConfig(principalId));
}

/** Id del negocio que guarda los datos de la sociedad (él mismo si es el principal). */
export async function principalFiscal(tenantId: string): Promise<string> {
  const cfg = await leerConfig(tenantId);
  const p = String(cfg?.fe_shared_from ?? '').trim();
  return p && p !== tenantId ? p : tenantId;
}

/** Sucursales de actividad que cuelgan de un principal. */
export async function sucursalesDeActividad(principalId: string) {
  const { data } = await db.from('settings').select('tenant_id, config')
    .eq('type', 'electronic-invoice').eq('config->>fe_shared_from', principalId);
  return ((data ?? []) as any[]).map(r => ({ tenant_id: String(r.tenant_id), config: r.config ?? {} }));
}

/**
 * Todas las actividades de la sociedad: la del principal primero (es la que
 * Alanube toma por defecto), después las demás que tenga inscritas y la de cada
 * sucursal. Alanube rechaza el comprobante que declara una actividad que la
 * empresa no tiene cargada, así que la lista tiene que estar completa.
 */
export async function actividadesDeLaSociedad(principalId: string, normalizar: (v: any) => string) {
  const principal = (await leerConfig(principalId)) ?? {};
  const sucursales = await sucursalesDeActividad(principalId);
  return [
    principal.economic_activity_code,
    ...(Array.isArray(principal.economic_activities) ? principal.economic_activities : []),
    ...sucursales.map(s => s.config.economic_activity_code),
  ].map(normalizar).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
}

/**
 * Guarda una config que llegó para una sucursal de actividad, repartiéndola.
 *
 * Lo de la actividad queda en la sucursal; lo de la sociedad se escribe en el
 * principal. Si se guardara todo en la sucursal, el cambio (un teléfono, un
 * correo) no llegaría nunca a los comprobantes, que leen del principal.
 */
export async function guardarRepartido(tenantId: string, config: Record<string, any>) {
  const propia = (await leerConfig(tenantId)) ?? {};
  const principalId = String(propia.fe_shared_from ?? config.fe_shared_from ?? '').trim();
  if (!principalId || principalId === tenantId) {
    await guardarConfig(tenantId, config);
    return { principalId: tenantId, config };
  }
  const principal = (await leerConfig(principalId)) ?? {};
  const nuevaPropia: Record<string, any> = { ...propia };
  const nuevoPrincipal: Record<string, any> = { ...principal };
  for (const [k, v] of Object.entries(config)) {
    if (esDeLaActividad(k)) nuevaPropia[k] = v;
    else nuevoPrincipal[k] = v;
  }
  // La marca nunca se pierde por un guardado que no la traía.
  nuevaPropia.fe_shared_from = principalId;
  await guardarConfig(principalId, nuevoPrincipal);
  await guardarConfig(tenantId, nuevaPropia);
  return { principalId, config: combinarConPrincipal(nuevaPropia, nuevoPrincipal) };
}

/**
 * Próximo número de sucursal libre para la cédula.
 *
 * Se mira TODO negocio con esa cédula, no solo el grupo: un número repetido
 * entre dos series de la misma cédula es un rechazo seguro.
 */
export async function siguienteSucursal(cedula: string): Promise<string> {
  const digitos = (v: any) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
  const buscada = digitos(cedula);
  const { data } = await db.from('settings').select('tenant_id, config').eq('type', 'electronic-invoice');
  const filas = (data ?? []) as any[];
  // Las sucursales de actividad no guardan la cédula: la heredan del principal.
  const deLaCedula = new Set(filas
    .filter(r => digitos(r.config?.emisor_identification) === buscada)
    .map(r => String(r.tenant_id)));
  let mayor = 0;
  for (const r of filas) {
    const cuenta = deLaCedula.has(String(r.tenant_id))
      || deLaCedula.has(String(r.config?.fe_shared_from ?? ''));
    if (!cuenta) continue;
    const n = parseInt(String(r.config?.sucursal ?? '1').replace(/\D/g, ''), 10);
    mayor = Math.max(mayor, Number.isFinite(n) && n > 0 ? n : 1);
  }
  return String(mayor + 1).padStart(3, '0');
}

/**
 * Deja el código de actividad en el ÚNICO formato que acepta el catálogo.
 *
 * El catálogo son cuatro dígitos, un punto y uno más: «4752.1». Pero el ATV lo
 * muestra de varias maneras y la gente lo copia como puede — con el nombre de la
 * actividad pegado, con guiones, o en seis dígitos seguidos («475201»). Cualquiera
 * de esas se rechaza, y el error que devuelve el proveedor es la lista completa
 * de trescientos códigos: ilegible, y sin decir cuál de los que mandamos falló.
 *
 * Se limpia lo que se pueda arreglar sin adivinar; lo que no, se devuelve vacío
 * para que la validación lo señale por nombre.
 */
export function normalizarActividad(valor: any): string {
  const texto = String(valor ?? '').trim();
  if (!texto) return '';

  // Ya viene bien.
  if (/^\d{4}\.\d$/.test(texto)) return texto;

  // Con el nombre pegado: «4752.1 - Venta de artículos de ferretería».
  const conNombre = /^(\d{4})[.\-\s]?(\d)\b/.exec(texto);
  if (conNombre) return `${conNombre[1]}.${conNombre[2]}`;

  // Seis dígitos seguidos: clase (4) + subdivisión (2). «475201» → «4752.1».
  const seis = /^(\d{4})(\d{2})$/.exec(texto.replace(/\D/g, ''));
  if (seis) return `${seis[1]}.${Number(seis[2])}`;

  return '';
}

const cedulaDe = (cfg: any) => String(cfg?.emisor_identification ?? '').replace(/\D/g, '').replace(/^0+/, '');

/**
 * La RAZÓN SOCIAL de un negocio: quién tiene la bolsa y qué negocios la gastan.
 *
 * La bolsa de comprobantes se cobra por razón social, no por sucursal. Antes
 * cada sucursal heredaba el límite de la principal pero contaba solo lo suyo:
 * tres sucursales con una bolsa de 300 podían emitir 900 pagando una.
 *
 *   · titular: el que guarda la bolsa. Para una actividad, su principal. Para
 *     una sucursal del grupo con la MISMA cédula que la matriz, la matriz. Si no,
 *     el propio negocio (otra razón social: tiene su propia bolsa, como los
 *     clientes de la cartera de un contador).
 *   · miembros: todos los negocios que emiten con esa cédula y están ligados al
 *     titular (por el grupo o como actividad). Sus comprobantes se suman.
 */
export async function razonSocialDe(tenantId: string): Promise<{ titular: string; miembros: string[]; cedula: string }> {
  const propia = (await leerConfig(tenantId)) ?? {};
  const cedula = cedulaDe(await configEfectiva(tenantId, propia));

  let titular = tenantId;
  const principalId = String(propia.fe_shared_from ?? '').trim();
  if (principalId && principalId !== tenantId) {
    titular = principalId;
  } else {
    const matriz = await matrizDelGrupo(tenantId);
    if (matriz && matriz !== tenantId) {
      const cedMatriz = cedulaDe(await configEfectiva(matriz));
      // Sin cédula propia (aún sin FE) o con la misma: es de la sociedad de la matriz.
      if (!cedula || cedula === cedMatriz) titular = matriz;
    }
  }

  const miembros = new Set<string>([titular, tenantId]);
  const cedTitular = cedulaDe(await configEfectiva(titular));
  if (cedTitular) {
    const { data: gm } = await db.from('tenant_group_members')
      .select('group_id').eq('tenant_id', titular).maybeSingle();
    const groupId = (gm as any)?.group_id;
    if (groupId) {
      const { data: otros } = await db.from('tenant_group_members').select('tenant_id').eq('group_id', groupId);
      for (const o of (otros ?? []) as any[]) {
        const id = String(o.tenant_id);
        if (miembros.has(id)) continue;
        if (cedulaDe(await configEfectiva(id)) === cedTitular) miembros.add(id);
      }
    }
    // Las actividades cuentan aunque las hayan sacado del grupo: emiten con esta cédula.
    for (const a of await sucursalesDeActividad(titular)) miembros.add(a.tenant_id);
  }
  return { titular, miembros: [...miembros], cedula: cedTitular };
}

/** Matriz (negocio 'main') del grupo al que pertenece el negocio, si tiene. */
async function matrizDelGrupo(tenantId: string): Promise<string | null> {
  const { data: gm } = await db.from('tenant_group_members')
    .select('group_id').eq('tenant_id', tenantId).maybeSingle();
  const groupId = (gm as any)?.group_id;
  if (!groupId) return null;
  const { data: grp } = await db.from('tenant_groups').select('*').eq('id', groupId).maybeSingle();
  if ((grp as any)?.main_tenant_id) return String((grp as any).main_tenant_id);
  const { data: m } = await db.from('tenant_group_members')
    .select('tenant_id').eq('group_id', groupId).eq('role', 'main').maybeSingle();
  return (m as any)?.tenant_id ? String((m as any).tenant_id) : null;
}
