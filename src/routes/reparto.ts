import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const reparto = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

/** Cómo se llama y se identifica el artículo del domicilio. */
const SKU = 'SRV-DOMICIL';
const NOMBRE = 'Entrega a domicilio';

/**
 * EL ARTÍCULO CON EL QUE SE COBRA EL DOMICILIO, resuelto solo.
 *
 * El cobro del domicilio viaja en la factura como una línea más, y eso obliga a
 * que exista un artículo: Hacienda no acepta un comprobante con una línea sin
 * artículo ni código, y el cierre de caja y el reporte de reparto necesitan
 * poder decir CUÁL de las líneas es el flete —sin eso, el domicilio se cuenta
 * como mercadería vendida—.
 *
 * Pero eso es un detalle del sistema, no una decisión del negocio. Antes había
 * que entrar a Ajustes → Delivery, crear o elegir un artículo y guardarlo; si
 * no, el botón del domicilio no aparecía y nadie sabía por qué. Ahora se
 * resuelve acá la primera vez que alguien cobra un domicilio:
 *
 *   1. El que ya está configurado, si todavía existe.
 *   2. Uno que ya exista en el catálogo (por SKU o por nombre): un negocio que
 *      lo creó a mano no tiene por qué terminar con dos.
 *   3. Y si no hay, se crea.
 *
 * Se crea desde el servidor a propósito: el cajero que cobra el domicilio
 * normalmente NO tiene permiso para crear productos, y no corresponde pedirle
 * que lo tenga para poder cobrar un flete.
 */
reparto.post('/articulo', async (c) => {
  try {
    const tenantId = c.get('tenantId');

    const { data: fila } = await db.from('settings').select('id, config')
      .eq('tenant_id', tenantId).eq('type', 'delivery').maybeSingle();
    const cfg: any = (fila as any)?.config ?? {};
    const yaPuesto = String(cfg.reparto_producto_id ?? '').trim();

    /* 1) El configurado, SI todavía existe. Un artículo borrado dejaba el
          ajuste apuntando al vacío y la línea del domicilio se rechazaba. */
    if (yaPuesto) {
      const { data: existe } = await db.from('products')
        .select('id').eq('tenant_id', tenantId).eq('id', yaPuesto).maybeSingle();
      if (existe) return ok(c, { producto_id: yaPuesto, creado: false, adoptado: false });
    }

    // 2) Uno que ya esté en el catálogo.
    const { data: porSku } = await db.from('products')
      .select('id').eq('tenant_id', tenantId).eq('sku', SKU).maybeSingle();
    let id = (porSku as any)?.id ? String((porSku as any).id) : '';
    let adoptado = !!id;
    if (!id) {
      const { data: porNombre } = await db.from('products')
        .select('id').eq('tenant_id', tenantId).ilike('name', NOMBRE).limit(1);
      const uno = ((porNombre ?? []) as any[])[0];
      if (uno?.id) { id = String(uno.id); adoptado = true; }
    }

    // 3) Crearlo.
    let creado = false;
    if (!id) {
      const { data, error } = await db.from('products').insert({
        tenant_id: tenantId, name: NOMBRE, sku: SKU,
        /* El precio es CERO en el catálogo porque el del flete no es uno: lo
           pone quien cobra, según la distancia. Dejarle una tarifa acá sería
           sugerir que todas las entregas cuestan lo mismo. */
        unit_price: 0, cost_price: 0,
        stock_quantity: 0, tracks_stock: false,
        /* Es un servicio con IVA, igual que cualquier transporte cobrado. */
        iva_rate: 13,
        description: 'Servicio de entrega. El monto lo pone el cajero según la distancia.',
      }).select('id').single();
      if (error) throw new Error(error.message);
      id = String((data as any).id);
      creado = true;
    }

    // Queda guardado para el cierre y el reporte, que buscan por este id.
    const guardar = {
      tenant_id: tenantId, type: 'delivery',
      config: { ...cfg, reparto_producto_id: id },
      updated_at: new Date().toISOString(),
    };
    const up = (fila as any)?.id
      ? await db.from('settings').update(guardar).eq('id', (fila as any).id)
      : await db.from('settings').insert(guardar);
    if (up.error) throw new Error(up.error.message);

    return ok(c, { producto_id: id, creado, adoptado });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default reparto;
