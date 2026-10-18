import { db } from '../db/client.js';
import { medirInfraestructura } from './infraUsage.js';
import { costoFE, documentosFE } from './costoFE.js';
import { leerGlobal } from './globalSettings.js';

/**
 * PRECIO DE COSTO CONTRA PRECIO DE VENTA, por plan.
 *
 * La pregunta que contesta: de lo que cobro por cada plan, ¿cuánto se va en
 * infraestructura y cuánto queda?
 *
 * ── La honestidad de este cálculo ─────────────────────────────────────────
 * El costo de infraestructura NO se puede atribuir de verdad por plan: la
 * factura de Supabase es una sola y no viene desglosada por negocio. Lo que
 * se hace acá es repartirla, y el reparto se dice en voz alta:
 *
 *   · por partes iguales entre los negocios activos, y
 *   · por PESO REAL en la base, que es lo que de verdad mueve la factura.
 *
 * Los dos números se muestran juntos justamente porque no coinciden: si un
 * plan barato resulta el más pesado, eso es lo que hay que ver. Un solo
 * número «costo por negocio» escondería ese caso, que es el único por el que
 * vale la pena abrir esta pantalla.
 *
 * Y lo que no se sabe, no se inventa: el egreso y Vercel no son medibles con
 * las llaves que tenemos (ver infraUsage.ts), así que el costo que sale acá
 * es un PISO, no la factura.
 */

const MES = 30 * 86_400_000;

/** Lo mismo que cobra una suscripción, llevado a un mes. */
function mensual(precio: number, ciclo: string): number {
  const c = String(ciclo ?? '').toLowerCase();
  if (c.includes('year') || c.includes('anual')) return precio / 12;
  if (c.includes('semes')) return precio / 6;
  if (c.includes('trimes') || c.includes('quarter')) return precio / 3;
  // Vitalicio: ya se pagó. Aporta ₡0 por mes y eso hay que verlo, no esconderlo.
  if (c.includes('life') || c.includes('vitalic')) return 0;
  return precio;
}

/**
 * LO QUE UN PLAN DEJA DE VERDAD, cuando el sistema no lo sabe.
 *
 * `subscription_plans.price` no siempre es el ingreso real: un plan vitalicio
 * en ₡0 puede estar cobrándose por fuera —una bolsa de facturas, un pago
 * único, un arreglo aparte— y el sistema no tiene cómo enterarse. Tratarlo
 * como ₡0 hacía que planes que SÍ dejan plata aparecieran como un lastre.
 *
 * Acá el administrador puede declarar cuánto deja cada uno por mes. Se guarda
 * aparte de la tabla de planes a propósito: es información comercial de él,
 * no una configuración del producto, y no debe cambiar lo que se le cobra a
 * nadie.
 */
async function ingresosDeclarados(): Promise<Record<string, number>> {
  const c = await leerGlobal<Record<string, number>>('plan-ingresos');
  return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
}

/** El tipo de cambio guardado. Null si no hay: no se inventa uno. */
async function tipoCambio(): Promise<number | null> {
  const c = await leerGlobal<any>('exchange-rate');
  const v = Number(c?.venta ?? 0);
  return v > 0 ? v : null;
}

export async function economiaDeLosPlanes() {
  const [{ data: planes }, { data: subs }, { data: tenants }, infra, tc, declarados] = await Promise.all([
    db.from('subscription_plans').select('id, name, price, billing_cycle, features, is_active'),
    db.from('subscriptions').select('tenant_id, plan_id, status, ends_at').eq('status', 'active'),
    db.from('tenants').select('id, name, status, is_demo'),
    medirInfraestructura(),
    tipoCambio(),
    ingresosDeclarados(),
  ]);

  const infoTenant = new Map(((tenants ?? []) as any[]).map(t => [t.id, t]));
  const nombreTenant = new Map(((tenants ?? []) as any[]).map(t => [t.id, t.name]));
  const hoyCR = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });

  /**
   * CUÁNDO FACTURÓ CADA UNO POR ÚLTIMA VEZ.
   *
   * Es la señal de uso que importa. Un negocio puede tener la suscripción al
   * día y no haber abierto el sistema en tres meses: ese no es un cliente, es
   * una baja que todavía no avisó, y contarlo como ingreso hace que el número
   * se vea mejor de lo que es.
   */
  const ultimaFactura = new Map<string, string>();

  /**
   * CUÁNTO PESA CADA NEGOCIO, de verdad.
   *
   * Se cuentan sus facturas: es la tabla que más crece y la que arrastra a
   * las demás (líneas, cuentas por cobrar, movimientos de caja). Repartir el
   * costo por cantidad de negocios trataría igual al que emite diez facturas
   * al mes que al que emite tres mil, y son los que deciden la factura.
   */
  const facturasPorTenant = new Map<string, number>();
  /**
   * Las del ÚLTIMO MES, aparte del histórico.
   *
   * El acumulado de siempre no dice lo que cuesta hoy: un negocio que emitió
   * dos mil facturas hace un año y hoy emite diez pesa como si siguiera
   * emitiendo dos mil. Lo que mueve la factura del mes es el volumen del mes.
   */
  const facturas30 = new Map<string, number>();
  const corte30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  /**
   * Las páginas se piden TODAS JUNTAS.
   *
   * Dieciséis mil facturas son diecisiete páginas, y pedirlas una tras otra
   * era casi todo el tiempo de esta pantalla: diecisiete esperas en fila
   * cuando ninguna depende de la anterior. Se pregunta primero cuántas hay y
   * después se piden todas a la vez.
   *
   * Importa de verdad: el servidor corre detrás de un proxy que corta la
   * petición pasado cierto tiempo, y cuando la cortaba el navegador mostraba
   * «NetworkError» —un mensaje que no dice nada y que parece un problema de
   * conexión del usuario, no una consulta lenta nuestra—.
   */
  const { count: totalFacturas } = await db.from('invoices')
    .select('*', { count: 'exact', head: true });
  const paginas = Math.max(1, Math.ceil(Number(totalFacturas ?? 0) / 1000));
  const trozos = await Promise.all(
    Array.from({ length: paginas }, (_, i) =>
      db.from('invoices').select('tenant_id, issued_at')
        .order('id', { ascending: true }).range(i * 1000, i * 1000 + 999)
        .then(r => (r.data ?? []) as any[], () => [] as any[])),
  );
  for (const f of trozos.flat()) {
    facturasPorTenant.set(f.tenant_id, (facturasPorTenant.get(f.tenant_id) ?? 0) + 1);
    if (String(f.issued_at) >= corte30) {
      facturas30.set(f.tenant_id, (facturas30.get(f.tenant_id) ?? 0) + 1);
    }
    const prev = ultimaFactura.get(f.tenant_id);
    if (!prev || String(f.issued_at) > prev) ultimaFactura.set(f.tenant_id, String(f.issued_at));
  }
  const facturas30Totales = [...facturas30.values()].reduce((s2, n) => s2 + n, 0) || 1;
  const facturasTotales = [...facturasPorTenant.values()].reduce((s, n) => s + n, 0) || 1;

  /**
   * El costo mensual de infraestructura, HOY y en el plan de pago.
   *
   * Hoy puede ser cero —si todo cabe en los planes gratuitos—, y ese cero es
   * un dato: dice que el margen está limitado por el precio, no por el costo.
   */
  const baseB = infra.supabase.base_bytes.valor ?? 0;
  const archB = infra.supabase.archivos_bytes.valor ?? 0;
  const mau = infra.supabase.mau_30d.valor ?? 0;
  const LIBRE = { base: 500 * 1048576, archivos: 1073741824, mau: 50_000 };
  const dentroDelGratis = baseB <= LIBRE.base && archB <= LIBRE.archivos && mau <= LIBRE.mau;

  /**
   * EL COSTO DE VERDAD incluye el proveedor de facturación electrónica.
   *
   * Esta pantalla decía «la infraestructura cuesta US$0» porque Supabase y
   * Vercel caben en el plan gratuito, y eso hacía ver todos los planes con
   * margen completo. Faltaba el costo real del negocio: el proveedor de FE
   * se paga todos los meses y, pasada la bolsa, cobra por documento.
   */
  const cFE = await costoFE();
  const docsFE = await documentosFE(30);
  const extrasFE = Math.max(0, docsFE.total - cFE.incluidos);
  const costoExtraFECrc = Math.round(extrasFE * cFE.extra_crc);

  const costoServidoresUsd = dentroDelGratis ? 0 : 25;    // Supabase Pro
  const costoUsdHoy = costoServidoresUsd + cFE.mensual_usd;
  const costoUsdSiPaga = 25 + 20 + cFE.mensual_usd;       // + Vercel Pro
  /**
   * Dólares a colones. Cero es cero en las dos monedas: sin esta salida
   * temprana, un costo de US$0 se mostraba como «—» cuando no hay tipo de
   * cambio guardado, y «—» se lee como «no sé» en un lugar donde sí sabemos.
   */
  const aColones = (usd: number) => (usd === 0 ? 0 : tc ? usd * tc : null);

  /**
   * EN QUÉ ESTADO ESTÁ CADA NEGOCIO.
   *
   * Tres cubetas, y la diferencia entre ellas es lo que vuelve útil la tabla:
   *   · al día     — paga y usa el sistema.
   *   · moroso     — la suscripción venció y sigue marcada activa.
   *   · inactivo   — está al día pero hace más de 60 días que no factura
   *                  (o nunca facturó).
   *
   * El ingreso se cuenta SOLO de los que están al día. Sumar a los morosos
   * infla el número con plata que no entró, que es exactamente el error que
   * hace que un negocio crea que está mejor de lo que está.
   */
  const DIAS_INACTIVO = 60;
  const estadoDe = (s: any): 'al_dia' | 'moroso' | 'inactivo' => {
    const t = infoTenant.get(s.tenant_id);
    if (t?.status === 'suspended') return 'moroso';
    if (s.ends_at && String(s.ends_at).slice(0, 10) < hoyCR) return 'moroso';
    const ult = ultimaFactura.get(s.tenant_id);
    if (!ult) return 'inactivo';
    const dias = Math.floor((Date.now() - new Date(ult).getTime()) / 86_400_000);
    return dias > DIAS_INACTIVO ? 'inactivo' : 'al_dia';
  };
  const diasSinFacturar = (tid: string): number | null => {
    const ult = ultimaFactura.get(tid);
    return ult ? Math.floor((Date.now() - new Date(ult).getTime()) / 86_400_000) : null;
  };

  /**
   * Las suscripciones vigentes, SIN los negocios de demostración.
   *
   * Un demo no es un cliente: no paga, se borra solo y aparecer en la lista de
   * «inactivos» solo ensucia la única lista que hay que atender. Se filtran
   * por la marca del negocio y no por el nombre del plan, porque un demo puede
   * estar colgado de un plan normal.
   */
  const activos = ((subs ?? []) as any[])
    .filter(s => !infoTenant.get(s.tenant_id)?.is_demo);

  const apartados: any[] = [];
  const alDia = activos.filter((s: any) => {
    const e = estadoDe(s);
    if (e === 'al_dia') return true;
    apartados.push({
      negocio: nombreTenant.get(s.tenant_id) ?? '—',
      tenant_id: s.tenant_id,
      plan: ((planes ?? []) as any[]).find(p => p.id === s.plan_id)?.name ?? '—',
      motivo: e,
      vence: s.ends_at ? String(s.ends_at).slice(0, 10) : null,
      dias_sin_facturar: diasSinFacturar(s.tenant_id),
      facturas: facturasPorTenant.get(s.tenant_id) ?? 0,
    });
    return false;
  });

  // Reparto por negocio: sobre los que están al día, que son los que pagan.
  const nNegocios = new Set(alDia.map((s: any) => s.tenant_id)).size || 1;

  const porPlan = new Map<string, any>();
  for (const s of alDia) {
    const plan = ((planes ?? []) as any[]).find(p => p.id === s.plan_id);
    if (!plan) continue;
    const clave = String(plan.id);
    const fila = porPlan.get(clave) ?? {
      id: plan.id,
      nombre: plan.name,
      es_demo: /^demo\s*·/i.test(String(plan.name ?? '')),
      precio: Number(plan.price ?? 0),
      ciclo: plan.billing_cycle,
      precio_mensual: mensual(Number(plan.price ?? 0), plan.billing_cycle),
      features: plan.features ?? {},
      negocios: 0,
      facturas: 0,
      facturas_mes: 0,
      nombres: [] as string[],
    };
    fila.negocios += 1;
    fila.facturas += facturasPorTenant.get(s.tenant_id) ?? 0;
    fila.facturas_mes += facturas30.get(s.tenant_id) ?? 0;
    if (fila.nombres.length < 6) fila.nombres.push(nombreTenant.get(s.tenant_id) ?? '—');
    porPlan.set(clave, fila);
  }

  const costoMensualUsd = costoUsdHoy;
  const filas = [...porPlan.values()]
    .filter(f => !f.es_demo)
    .map(f => {
      /**
       * El ingreso: lo que dice el plan, o lo que declaró el administrador.
       *
       * Lo declarado MANDA. Un vitalicio en ₡0 puede estar cobrándose por
       * fuera —una bolsa de facturas, un arreglo aparte— y el sistema no
       * tiene cómo saberlo; tratarlo como cero hacía que un plan que sí deja
       * plata apareciera como un lastre.
       */
      const declarado = Number((declarados as any)[f.id] ?? NaN);
      const hayDeclarado = Number.isFinite(declarado) && declarado >= 0;
      const ingreso = hayDeclarado ? declarado * f.negocios : f.precio_mensual * f.negocios;

      const costoParejo = aColones((costoMensualUsd / nNegocios) * f.negocios);
      /**
       * El costo se reparte por el volumen DEL MES, no por el histórico.
       *
       * Con el acumulado, un negocio que emitió miles de facturas hace un año
       * y hoy emite diez cargaba como si siguiera emitiendo miles. Lo que
       * mueve la factura de este mes es lo que se emitió este mes.
       */
      const parte = f.facturas_mes / facturas30Totales;
      const costoPorPeso = aColones(costoMensualUsd * parte);
      /**
       * El costo también en DÓLARES, siempre.
       *
       * Sin tipo de cambio guardado, la columna en colones salía «—» y daba
       * a entender que no se sabe cuánto cuesta. Sí se sabe: la factura del
       * proveedor viene en dólares. Lo que falta es la conversión, no el
       * dato, y la pantalla puede mostrar el que hay.
       */
      const costoPorPesoUsd = Math.round(costoMensualUsd * parte * 100) / 100;
      return {
        ...f,
        costo_por_peso_usd: costoPorPesoUsd,
        ingreso_declarado: hayDeclarado ? declarado : null,
        ingreso_mensual: ingreso,
        /** Repartiendo la factura por partes iguales entre negocios. */
        costo_parejo: costoParejo,
        /** Repartiéndola según cuánto se emitió ESTE MES. */
        costo_por_peso: costoPorPeso,
        margen: costoPorPeso != null ? ingreso - costoPorPeso : null,
        /** Qué parte de las facturas DEL MES se lleva este plan. */
        peso_pct: Math.round((f.facturas_mes / facturas30Totales) * 1000) / 10,
        /** Promedio de facturas por negocio en el mes: el costo real de tenerlo. */
        facturas_por_negocio_mes: f.negocios ? Math.round((f.facturas_mes / f.negocios) * 10) / 10 : 0,
      };
    })
    .sort((a, b) => b.ingreso_mensual - a.ingreso_mensual);

  const ingresoTotal = filas.reduce((s, f) => s + f.ingreso_mensual, 0);
  /**
   * Los que de verdad no dejan nada.
   *
   * Si el administrador declaró un ingreso, el plan NO entra acá aunque el
   * sistema lo tenga en ₡0: él sabe lo que cobra y el sistema no. Y se
   * muestra cuánto emiten por negocio, porque «no deja plata» pesa distinto
   * según si son diez facturas al mes o dos mil.
   */
  const sinIngreso = filas.filter(f => f.ingreso_mensual <= 0 && f.negocios > 0);

  return {
    medido_en: new Date().toISOString(),
    tipo_cambio: tc,
    negocios_activos: nNegocios,
    facturas_totales: facturasTotales,
    infraestructura: {
      dentro_del_plan_gratis: dentroDelGratis,
      costo_usd_hoy: costoUsdHoy,
      costo_crc_hoy: aColones(costoUsdHoy),
      costo_usd_si_pagaras: costoUsdSiPaga,
      costo_crc_si_pagaras: aColones(costoUsdSiPaga),
      /** De dónde sale cada dólar: sin esto, «US$56» no se puede verificar. */
      desglose: {
        servidores_usd: costoServidoresUsd,
        facturacion_electronica_usd: cFE.mensual_usd,
        documentos_extra_crc: costoExtraFECrc,
      },
      fe: {
        incluidos: cFE.incluidos,
        usados: docsFE.total,
        libres: Math.max(0, cFE.incluidos - docsFE.total),
        extra_crc: cFE.extra_crc,
        pasados: extrasFE,
      },
      nota: 'Es un PISO, no la factura: el egreso de Supabase y el consumo de Vercel no se '
        + 'pueden medir con las llaves que tenemos.',
    },
    planes: filas,
    ingreso_mensual_total: ingresoTotal,
    /**
     * Los planes que no cobran nada pero sí ocupan infraestructura.
     *
     * Es el número que más cuesta mirar y el que más sirve: un vitalicio a ₡0
     * no deja de costar porque ya se haya pagado.
     */
    planes_sin_ingreso: sinIngreso.map(f => ({
      id: f.id, nombre: f.nombre, negocios: f.negocios, facturas: f.facturas,
      facturas_mes: f.facturas_mes, facturas_por_negocio_mes: f.facturas_por_negocio_mes,
      peso_pct: f.peso_pct,
    })),
    /**
     * IDEAS DE PLANES, salidas de lo que pasa de verdad.
     *
     * No son plantillas genéricas de «3 niveles y listo»: cada una señala un
     * hueco medido en los datos de este negocio. Son para decidir, no para
     * aplicar: quien les pone precio es quien conoce el mercado.
     */
    propuestas: proponerPlanes(filas, apartados, sinIngreso),
    /**
     * LOS QUE QUEDARON FUERA DEL CÁLCULO, y por qué.
     *
     * No se esconden: se apartan y se listan. Un moroso que sigue usando el
     * sistema es plata que hay que ir a cobrar, y un negocio que no factura
     * hace meses es una baja que todavía no avisó. Las dos cosas se atienden
     * distinto, y por eso van separadas en vez de en un solo montón.
     */
    apartados,
    resumen_apartados: {
      morosos: apartados.filter(a => a.motivo === 'moroso').length,
      inactivos: apartados.filter(a => a.motivo === 'inactivo').length,
      dias_para_inactivo: DIAS_INACTIVO,
    },
  };
}

/**
 * QUÉ PLANES CONVENDRÍA TENER.
 *
 * Cada propuesta nace de un número que ya está medido arriba, y lo dice. Una
 * idea de plan sin un dato detrás es una opinión, y de opiniones sobre precios
 * ya hay suficientes; lo que falta es saber qué está pasando.
 *
 * Ninguna trae precio sugerido. El costo de infraestructura por negocio es
 * centavos —la restricción real es cuánto está dispuesto a pagar un comercio
 * en Costa Rica—, y eso no está en esta base.
 */
function proponerPlanes(filas: any[], apartados: any[], sinIngreso: any[]) {
  const p: Array<{ nombre: string; idea: string; porque: string; a_quien: string }> = [];

  // 1) Los que no pagan nada y ocupan lugar.
  const gratis = sinIngreso.reduce((s, x) => s + x.negocios, 0);
  if (gratis > 0) {
    p.push({
      nombre: 'Plan de entrada pago (reemplazo del vitalicio en ₡0)',
      idea: 'Un escalón barato y MENSUAL, en vez de regalar el acceso para siempre. '
        + 'Lo barato engancha igual; lo vitalicio en ₡0 no deja ni la posibilidad de subir.',
      porque: `Hoy ${gratis} negocios no generan ningún ingreso y siguen ocupando base, `
        + 'archivos y usuarios activos todos los meses.',
      a_quien: 'Los que hoy están en planes de ₡0.',
    });
  }

  // 2) Los que se fueron sin avisar.
  const inactivos = apartados.filter(a => a.motivo === 'inactivo').length;
  if (inactivos >= 3) {
    p.push({
      nombre: 'Plan «solo facturar», mínimo',
      idea: 'Un plan chiquito para el que no necesita punto de venta ni inventario: solo emitir '
        + 'la factura electrónica cuando le toca. Barato, sin módulos de más.',
      porque: `${inactivos} negocios con suscripción al día llevan meses sin facturar. `
        + 'Un plan grande que no se usa se termina cancelando; uno chico se sostiene.',
      a_quien: 'Profesionales independientes y negocios que facturan poco.',
    });
  }

  // 3) El que paga poco y pesa mucho.
  const pesado = [...filas].sort((a, b) => b.peso_pct - a.peso_pct)[0];
  if (pesado && pesado.peso_pct > 20 && pesado.negocios <= 3) {
    p.push({
      nombre: `Plan por volumen (a la medida de «${pesado.nombre}»)`,
      idea: 'Un escalón con precio por cantidad de facturas, para los que usan el sistema mucho '
        + 'más que el promedio. Hoy pagan lo mismo que alguien que emite diez por mes.',
      porque: `«${pesado.nombre}» tiene ${pesado.negocios} negocio(s) y se lleva el `
        + `${pesado.peso_pct}% de todas las facturas del sistema.`,
      a_quien: 'Distribuidores, verdulerías y cualquiera que facture a diario.',
    });
  }

  // 4) Lo que ya está hecho y nadie sabe que existe.
  p.push({
    nombre: 'Paquete de arranque (acompañamiento incluido)',
    idea: 'El mismo plan de siempre pero con una videollamada de media hora para dejar cargados '
      + 'los productos y configurado lo básico. Se cobra una vez, al inicio.',
    porque: 'Los módulos más desaprovechados —compras, gastos, promociones— están incluidos en '
      + 'los planes y vacíos en la mayoría de los negocios: no es que no sirvan, es que nadie '
      + 'los arrancó. Lo que frena no es el precio, es el primer día.',
    a_quien: 'Clientes nuevos, como complemento de cualquier plan.',
  });

  // 5) Lo que ya existe en el sistema y no se está vendiendo aparte.
  p.push({
    nombre: 'Página pública y catálogo con QR, como complemento',
    idea: 'Vender aparte la vitrina pública —menú o catálogo con código QR, con sus promociones— '
      + 'a los negocios que no lo tienen en el plan.',
    porque: 'Ya está construido y funcionando; el costo de sumarle un negocio más es casi cero, '
      + 'así que cada venta es margen casi completo.',
    a_quien: 'Sodas, restaurantes y tiendas que quieren mostrar precios sin imprimir nada.',
  });

  return p;
}
