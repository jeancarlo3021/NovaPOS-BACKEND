import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { sincronizarEmpresaEnAlanube } from './admin.js';

const settings = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// GET /:type — get settings for tenant by type
settings.get('/:type', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { type } = c.req.param();
    const { data, error } = await db.from('settings').select('*')
      .eq('tenant_id', tenantId).eq('type', type).maybeSingle();
    if (error) throw new Error(error.message);
    return ok(c, data?.config ?? {});
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** ¿El usuario es super-admin? (su plan tiene admin_dashboard=true). */
async function isSuperAdmin(userId: string): Promise<boolean> {
  try {
    const { data: u } = await db.from('users').select('tenant_id').eq('id', userId).maybeSingle();
    if (!u?.tenant_id) return false;
    const { data: t } = await db.from('tenants').select('plan_id').eq('id', u.tenant_id).maybeSingle();
    if (!t?.plan_id) return false;
    const { data: p } = await db.from('subscription_plans').select('features').eq('id', t.plan_id).maybeSingle();
    return (p?.features as any)?.admin_dashboard === true;
  } catch { return false; }
}

// PUT /:type — upsert settings
settings.put('/:type', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { type } = c.req.param();
    let config = await c.req.json();

    /**
     * Facturación electrónica: el negocio solo puede tocar SUS DATOS DE CONTACTO.
     *
     * Lo demás —cédula, razón social, ubicación, actividad, certificado, token,
     * credenciales de ATV, ambiente— tiene que coincidir con lo inscrito ante
     * Hacienda: cambiarlo no corrige nada, hace que los comprobantes se rechacen
     * o, peor, que se emitan a nombre equivocado.
     *
     * Antes esto se guardaba enviando el objeto ENTERO: quien llamara al API
     * podía reescribir la cédula o dejar la configuración sin certificado. La
     * pantalla tenía el cuidado de leer lo guardado y mezclar, pero eso es una
     * cortesía del cliente, no una protección.
     *
     * Ahora, salvo el super-admin, solo pasan los campos de esta lista y se
     * mezclan sobre lo que ya estaba guardado.
     */
    if (type === 'electronic-invoice' && !(await isSuperAdmin(c.get('userId')))) {
      const { data: prev } = await db.from('settings').select('config')
        .eq('tenant_id', tenantId).eq('type', type).maybeSingle();
      const guardado: Record<string, any> = { ...((prev?.config as any) ?? {}) };

      /**
       * Lo que el negocio SÍ conoce y le cambia solo.
       *
       * La ubicación y las actividades económicas son datos del contribuyente
       * que el negocio maneja mejor que nadie —se mudó, abrió una actividad
       * nueva— y hasta ahora tenía que pedirlos por soporte para algo que sabe
       * de memoria. Si pone algo que no le corresponde, Hacienda rechaza el
       * comprobante y el error se ve de inmediato.
       *
       * Fuera de la lista queda lo que NO puede cambiar sin romper la emisión:
       * cédula y razón social (identifican al contribuyente y tienen que
       * coincidir con el certificado), el certificado y su clave, el token de la
       * cuenta, las credenciales de ATV y el ambiente.
       */
      const EDITABLES = [
        'emisor_commercial_name',   // nombre comercial (rótulo, no la razón social)
        'emisor_phone', 'emisor_phones',
        'emisor_address',           // otras señas / dirección exacta
        'emisor_email', 'emisor_emails',
        'emisor_province_code', 'emisor_canton_code', 'emisor_district_code',
        'economic_activity_code', 'economic_activities',
        'default_document_type',    // qué comprobante sale por defecto en el POS
      ];
      for (const k of EDITABLES) {
        if (Object.prototype.hasOwnProperty.call(config, k)) guardado[k] = config[k];
      }
      config = guardado;
    }

    const { data, error } = await db.from('settings').upsert({
      tenant_id: tenantId, type, config,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,type' }).select().single();

    if (error) throw new Error(error.message);

    /**
     * Los datos de contacto también se mandan a Alanube.
     *
     * El teléfono, el correo, la dirección y el nombre comercial salen impresos
     * en el comprobante que emite Alanube, no en el nuestro. Guardarlos solo acá
     * dejaba el comprobante con los datos viejos, y quien los corrigió no tenía
     * cómo enterarse: parecía guardado y funcionando.
     *
     * Si falla no se pierde el cambio —ya quedó guardado— pero se avisa, porque
     * hasta que se sincronice el comprobante sigue saliendo con lo anterior.
     */
    let alanube: { ok: boolean; motivo?: string } | null = null;
    if (type === 'electronic-invoice') {
      alanube = await sincronizarEmpresaEnAlanube(tenantId);
    }

    return ok(c, {
      ...(data?.config ?? config),
      alanube_sync: alanube?.ok ?? null,
      alanube_motivo: alanube?.ok === false ? alanube.motivo : undefined,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default settings;
