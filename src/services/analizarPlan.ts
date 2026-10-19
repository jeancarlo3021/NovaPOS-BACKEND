import { db } from '../db/client.js';
import { economiaDeLosPlanes } from './planEconomics.js';
import { costoFE, documentosFE, costoDeAgregar } from './costoFE.js';
import { costosFijos } from './costosFijos.js';

/**
 * ANALIZAR UN PLAN QUE TODAVÍA NO EXISTE.
 *
 * Alguien propone «un plan de ₡8.000 con inventario y facturación» y esto
 * contesta qué tiene de bueno y qué de malo, con los números del negocio.
 *
 * ── Por qué esto NO lo escribe un modelo de lenguaje ──────────────────────
 * Un modelo da una respuesta preciosa y genérica: «considerá el valor
 * percibido, segmentá tu mercado». Eso ya se sabe. Lo que no se sabe —y es lo
 * único que cambia una decisión— es que a ₡8.000 hay ONCE clientes pagando
 * ₡15.000 que se cambiarían, y que recuperar esa plata pide quince clientes
 * nuevos. Ese número sale de la base, no de un modelo.
 *
 * Cuando la IA esté encendida va a redactar; los números siguen saliendo de
 * acá.
 */

/**
 * LA CUENTA, separada del resto del análisis.
 *
 * Estaba desparramada entre los puntos a favor y en contra, y ahí se lee como
 * un comentario más. Cuánto cuesta y cuánto queda es LA pregunta: va aparte y
 * siempre, aunque la respuesta sea «no cuesta nada todavía».
 */
export interface Economia {
  precio_mensual: number;
  /**
   * Lo que se paga todos los meses haya o no un cliente más.
   *
   * No se reparte entre los clientes: el costo de uno MÁS es su variable.
   * Los fijos van aparte, con cuántos clientes hacen falta para cubrirlos,
   * que es la pregunta que de verdad decide si el plan se sostiene.
   */
  fijos?: {
    total_usd: number; total_crc: number | null;
    conceptos: Array<{ concepto: string; usd: number; nota: string }>;
    tipo_cambio: number | null; tipo_cambio_fuente: string;
    clientes_para_cubrirlos: number | null;
  };
  /** Lo que cuesta atender UN cliente más de este plan. */
  costo_por_cliente: number;
  costo_detalle: Array<{ concepto: string; monto: number; nota?: string }>;
  ganancia_por_cliente: number;
  margen_pct: number | null;
  /** Qué pasa con 5, 10 y 25 clientes: la bolsa de FE se va llenando. */
  escenarios: Array<{
    clientes: number; ingreso: number; costo: number; ganancia: number; nota?: string;
  }>;
}

export interface Analisis {
  entendido: { precio: number | null; ciclo: 'mensual' | 'anual'; modulos: string[] };
  economia?: Economia;
  numeros: Record<string, any>;
  bueno: string[];
  malo: string[];
  veredicto: string;
  /** Lo que haría falta saber y no está en la base. */
  no_puedo_saber: string[];
}

/** Los módulos que se reconocen por su nombre común. */
const MODULOS: Array<{ flag: string; nombre: string; palabras: string[] }> = [
  { flag: 'pos', nombre: 'Punto de venta', palabras: ['punto de venta', 'pos', 'caja', 'cobrar'] },
  { flag: 'inventory', nombre: 'Inventario', palabras: ['inventario', 'stock', 'existencias'] },
  { flag: 'electronic_invoice', nombre: 'Facturación electrónica', palabras: ['factura', 'electronica', 'hacienda', 'fe'] },
  { flag: 'reports', nombre: 'Reportes', palabras: ['reporte', 'informe'] },
  { flag: 'expenses', nombre: 'Gastos', palabras: ['gasto', 'egreso'] },
  { flag: 'purchases', nombre: 'Compras', palabras: ['compra', 'proveedor'] },
  { flag: 'customers', nombre: 'Clientes', palabras: ['cliente'] },
  { flag: 'accounts_receivable', nombre: 'Cuentas por cobrar', palabras: ['por cobrar', 'credito', 'fiado'] },
  { flag: 'promotions', nombre: 'Promociones', palabras: ['promocion', 'descuento', '2x1'] },
  { flag: 'multi_branch', nombre: 'Multi-sucursal', palabras: ['sucursal', 'local'] },
  { flag: 'digital_menu', nombre: 'Menú digital', palabras: ['menu digital', 'carta', 'qr'] },
  { flag: 'digital_catalog', nombre: 'Catálogo digital', palabras: ['catalogo'] },
  { flag: 'hr', nombre: 'Planilla', palabras: ['planilla', 'recursos humanos', 'empleado'] },
  { flag: 'tables', nombre: 'Mapa de mesas', palabras: ['mesa', 'salon'] },
];

const norm = (s: string) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Qué precio se está proponiendo.
 *
 * Se aceptan «₡8.000», «8000», «8 mil». Si no hay número, se dice que no se
 * entendió en vez de suponer uno: un análisis con un precio inventado es
 * peor que no tener análisis.
 */
function precioDe(texto: string): number | null {
  const t = norm(texto);
  const mil = t.match(/(\d+(?:[.,]\d+)?)\s*mil\b/);
  if (mil) return Math.round(parseFloat(mil[1].replace(',', '.')) * 1000);
  const n = t.match(/[₡c$]?\s*(\d{1,3}(?:[.,]\d{3})+|\d{3,7})/);
  if (!n) return null;
  const limpio = n[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.');
  const v = Math.round(parseFloat(limpio));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function modulosDe(texto: string): string[] {
  const t = norm(texto);
  // «todo» / «completo» = todos los módulos, que es como lo diría alguien.
  if (/\b(todo|completo|full)\b/.test(t)) return MODULOS.map(m => m.nombre);
  return MODULOS.filter(m => m.palabras.some(p => t.includes(norm(p)))).map(m => m.nombre);
}

/**
 * Cuántas facturas al mes emitiría un cliente de este plan.
 *
 * Si se dice en el texto («para quien factura 300 al mes»), se usa ese
 * número. Si no, se usa el promedio REAL de los clientes que hoy facturan
 * electrónicamente: suponer un número redondo cuando hay una medición al
 * lado sería tirar el dato que sirve.
 */
function facturasEsperadas(texto: string): number | null {
  const t = norm(texto);
  const m = t.match(/(\d{1,5})\s*(?:facturas?|documentos?|comprobantes?)/);
  return m ? parseInt(m[1], 10) : null;
}

export async function analizarPlan(texto: string): Promise<Analisis> {
  const precio = precioDe(texto);
  const anual = /\banual|por a[nñ]o|al a[nñ]o\b/.test(norm(texto));
  const modulos = modulosDe(texto);

  const eco = await economiaDeLosPlanes();
  const mensualPropuesto = precio == null ? null : (anual ? Math.round(precio / 12) : precio);

  const bueno: string[] = [];
  const malo: string[] = [];
  const numeros: Record<string, any> = {};
  const noPuedo: string[] = [];

  if (mensualPropuesto == null) {
    return {
      entendido: { precio: null, ciclo: anual ? 'anual' : 'mensual', modulos },
      numeros: {}, bueno: [], malo: [],
      veredicto: 'No encontré un precio en lo que escribiste. Decime cuánto costaría '
        + '—por ejemplo «un plan de ₡8.000 con inventario y facturación»— y lo analizo '
        + 'contra tus números.',
      no_puedo_saber: [],
    };
  }

  const money = (n: number) => `₡${Math.round(n).toLocaleString('es-CR')}`;

  /**
   * CANIBALIZACIÓN: el número que de verdad decide.
   *
   * Cuántos de los que hoy pagan MÁS se pasarían a este plan si les sirve.
   * Es lo que casi nadie calcula antes de lanzar un plan barato, y es lo que
   * hace que el mes siguiente entre menos plata con más clientes.
   */
  const masCaros = eco.planes.filter((p: any) => p.precio_mensual > mensualPropuesto && p.negocios > 0);
  const negociosEnRiesgo = masCaros.reduce((s: number, p: any) => s + p.negocios, 0);
  const ingresoEnRiesgo = masCaros.reduce((s: number, p: any) => s + p.ingreso_mensual, 0);
  const ingresoSiSeCambian = negociosEnRiesgo * mensualPropuesto;
  const perdida = ingresoEnRiesgo - ingresoSiSeCambian;

  numeros.precio_mensual = money(mensualPropuesto);
  if (anual) numeros.precio_anual = money(precio!);
  numeros.ingreso_actual = money(eco.ingreso_mensual_total);
  numeros.negocios_que_pagan = eco.negocios_activos;

  if (negociosEnRiesgo > 0) {
    numeros.podrian_cambiarse = `${negociosEnRiesgo} negocios de ${masCaros.map((p: any) => `«${p.nombre}»`).join(', ')}`;
    numeros.perdida_si_se_cambian_todos = money(perdida);
    numeros.clientes_nuevos_para_compensar = Math.ceil(perdida / mensualPropuesto);
    malo.push(
      `Hay ${negociosEnRiesgo} negocios pagando más que esto. Si se pasaran todos, entrarían `
      + `${money(perdida)} menos por mes, y harían falta ${Math.ceil(perdida / mensualPropuesto)} `
      + 'clientes nuevos solo para quedar igual que hoy.');
  } else {
    bueno.push('Nadie de tu cartera actual paga menos que esto, así que no te quita clientes '
      + 'de los planes que ya tenés: todo lo que entre es plata nueva.');
  }

  /**
   * MARGEN. El costo de infraestructura por negocio es casi nada, y decirlo
   * con el número evita la conversación de «¿no saldrá muy barato?».
   */
  const costoUsd = eco.infraestructura.costo_usd_hoy;
  if (costoUsd === 0) {
    numeros.costo_de_servidores = 'US$0 (Supabase y Vercel caben en el plan gratuito)';
  } else {
    numeros.costo_de_servidores = `US$${costoUsd}/mes`;
  }

  /**
   * EL COSTO QUE DE VERDAD IMPORTA: la facturación electrónica.
   *
   * Es el único costo variable del negocio. Antes este análisis decía «el
   * margen es prácticamente todo» porque solo miraba los servidores, que
   * están en plan gratuito, e ignoraba que el proveedor de FE se paga todos
   * los meses y cobra por documento pasada la bolsa.
   *
   * Y la bolsa está casi llena, así que el costo del próximo cliente NO es
   * cero: es lo que emita, por el precio del documento extra.
   */
  const cFE = await costoFE();
  const docs = await documentosFE(30);
  const libres = Math.max(0, cFE.incluidos - docs.total);
  numeros.proveedor_de_fe = `US$${cFE.mensual_usd}/mes · ${cFE.incluidos} documentos incluidos · `
    + `₡${cFE.extra_crc} cada uno de más`;
  numeros.documentos_este_mes = `${docs.total} de ${cFE.incluidos} (${libres} libres)`;

  const esPlanFE = modulos.length === 0 || modulos.includes('Facturación electrónica');
  const dichas = facturasEsperadas(texto);
  // Promedio real de los que hoy facturan electrónicamente, no un número redondo.
  const emisores = [...docs.por_tenant.values()].filter(n => n > 0);
  const promedio = emisores.length
    ? Math.round(emisores.reduce((a, b) => a + b, 0) / emisores.length) : 0;
  const esperadas = dichas ?? promedio;

  if (esPlanFE && esperadas > 0) {
    const costoCliente = costoDeAgregar(esperadas, docs.total, cFE);
    numeros.facturas_esperadas_por_cliente = dichas
      ? `${esperadas}/mes (lo dijiste vos)`
      : `${esperadas}/mes (promedio real de los que facturan hoy)`;
    numeros.costo_fe_por_cliente_nuevo = money(costoCliente);

    if (costoCliente === 0) {
      bueno.push(`Todavía quedan ${libres} documentos de la bolsa de ${cFE.incluidos}, así que un `
        + `cliente que emita ${esperadas} al mes no agrega costo: entra en lo ya pagado.`);
      const cabenAun = Math.floor(libres / esperadas);
      if (cabenAun >= 1) {
        numeros.clientes_que_caben_sin_costo_extra = cabenAun;
        malo.push(`Pero solo caben ${cabenAun} cliente(s) más así antes de pasarse de la bolsa. `
          + `Del siguiente en adelante, cada uno cuesta unos ${money(esperadas * cFE.extra_crc)} por mes.`);
      }
    } else {
      const margen = mensualPropuesto - costoCliente;
      numeros.margen_por_cliente = money(margen);
      if (margen <= 0) {
        malo.push(`A ${money(mensualPropuesto)} PERDÉS plata con cada cliente: emitiendo ${esperadas} `
          + `documentos al mes te cuesta ${money(costoCliente)} en facturación electrónica.`);
      } else if (costoCliente > mensualPropuesto * 0.3) {
        malo.push(`La facturación electrónica se come ${money(costoCliente)} de los `
          + `${money(mensualPropuesto)} (${Math.round((costoCliente / mensualPropuesto) * 100)}%): `
          + 'ya pasaste la bolsa incluida y cada documento se paga aparte.');
      } else {
        bueno.push(`Deja ${money(margen)} por cliente después de pagar la facturación electrónica `
          + `(${money(costoCliente)} por ${esperadas} documentos).`);
      }
    }

    /** Cuándo deja de dar plata. El número que nadie calcula. */
    if (cFE.extra_crc > 0) {
      const tope = Math.floor(mensualPropuesto / cFE.extra_crc);
      numeros.facturas_con_las_que_deja_de_dar_plata = `${tope.toLocaleString('es-CR')}/mes`;
      if (esperadas > tope * 0.5) {
        malo.push(`Un cliente que emita más de ${tope.toLocaleString('es-CR')} documentos al mes te `
          + `cuesta más de lo que paga. Con ${esperadas} de promedio ya estás a mitad de camino.`);
      }
    }
  } else if (!esPlanFE) {
    bueno.push('Sin facturación electrónica, el costo variable es cero: lo único que cuesta es '
      + 'tu tiempo de soporte.');
  }

  /** Si pide módulos, mirar si los clientes de hoy los usan. */
  if (modulos.length > 0) {
    numeros.modulos = modulos.join(', ');
    if (modulos.length >= 8) {
      malo.push(`Son ${modulos.length} módulos en un plan de ${money(mensualPropuesto)}. `
        + 'Cuantos más módulos entren al plan barato, menos razón tiene alguien para pasarse '
        + 'a uno caro: el plan de arriba se queda sin argumento.');
    } else {
      bueno.push(`Son ${modulos.length} módulos, acotado: deja lugar para que un plan más caro `
        + 'tenga algo que ofrecer.');
    }
  } else {
    noPuedo.push('Qué módulos incluiría: no los nombraste, así que no puedo decir si se pisa '
      + 'con los planes que ya tenés.');
  }

  /** Comparación con lo que ya cobra. */
  const precios = eco.planes.filter((p: any) => p.precio_mensual > 0).map((p: any) => p.precio_mensual);
  if (precios.length) {
    const min = Math.min(...precios);
    numeros.plan_mas_barato_hoy = money(min);
    if (mensualPropuesto < min * 0.5) {
      malo.push(`Es menos de la mitad de tu plan más barato de hoy (${money(min)}). Un salto así `
        + 'hacia abajo no se lee como una opción nueva: se lee como que lo de antes estaba caro.');
    }
  }

  /** Lo que NO está en la base y hay que poner de afuera. */
  noPuedo.push('Cuánto tiempo de soporte te va a pedir cada cliente de este plan: eso no está '
    + 'en ningún lado, y con el costo de facturación ya contado, es lo que queda por definir.');
  noPuedo.push('Cuántos clientes nuevos traería. Lo de arriba dice qué pasa con los que YA '
    + 'tenés; lo que entra depende del mercado.');

  /**
   * LA CUENTA: cuánto cuesta y cuánto queda.
   *
   * El costo de un cliente MÁS es el marginal, no una porción de los fijos.
   * Los US$56 del proveedor ya se pagan todos los meses: sumar un cliente no
   * los aumenta hasta que se acaba la bolsa de documentos. Repartir el fijo
   * entre los clientes daría un «costo por cliente» que baja solo con crecer,
   * y con eso cualquier precio parece rentable.
   *
   * Los escenarios sí muestran el efecto acumulado: con cada cliente la bolsa
   * se llena un poco más, y en algún punto el documento siguiente ya se paga.
   * Ese salto es lo que no se ve mirando un cliente aislado.
   */
  const fijos = await costosFijos();
  /** Cuántos clientes de este plan pagarían TODOS los costos fijos del mes. */
  const equilibrio = (aporte: number) =>
    fijos.total_crc != null && aporte > 0 ? Math.ceil(fijos.total_crc / aporte) : null;

  let economia: any = undefined;
  if (esPlanFE && esperadas > 0) {
    const costoUno = costoDeAgregar(esperadas, docs.total, cFE);
    const detalle: any[] = [{
      concepto: 'Facturación electrónica',
      monto: costoUno,
      nota: costoUno === 0
        ? `Entra en la bolsa ya pagada (quedan ${libres} documentos)`
        : `${esperadas} documentos × ₡${cFE.extra_crc}`,
    }];
    const escenarios = [5, 10, 25].map(n => {
      // Cada cliente empuja al siguiente más cerca del borde de la bolsa.
      const docsTotales = esperadas * n;
      const costo = costoDeAgregar(docsTotales, docs.total, cFE);
      const ingreso = mensualPropuesto * n;
      const seLlena = docs.total + docsTotales > cFE.incluidos;
      return {
        clientes: n, ingreso, costo, ganancia: ingreso - costo,
        nota: seLlena
          ? `La bolsa se llena: ${docs.total + docsTotales - cFE.incluidos} documentos se pagan aparte`
          : 'Todo entra en la bolsa ya pagada',
      };
    });
    economia = {
      precio_mensual: mensualPropuesto,
      costo_por_cliente: costoUno,
      costo_detalle: detalle,
      ganancia_por_cliente: mensualPropuesto - costoUno,
      margen_pct: mensualPropuesto > 0
        ? Math.round(((mensualPropuesto - costoUno) / mensualPropuesto) * 1000) / 10 : null,
      escenarios,
      fijos: { ...fijos, clientes_para_cubrirlos: equilibrio(mensualPropuesto - costoUno) },
    };
  } else {
    /** Sin facturación electrónica no hay costo variable: el margen es el precio. */
    /**
     * Sin facturación electrónica no hay costo VARIABLE: un cliente más no
     * mueve la factura de nadie. Pero eso no es «margen del 100%», que era lo
     * que decía antes: los costos fijos existen igual y hay que cubrirlos.
     * Por eso van al lado, con cuántos clientes hacen falta.
     */
    economia = {
      precio_mensual: mensualPropuesto,
      costo_por_cliente: 0,
      costo_detalle: [{
        concepto: 'Costo variable',
        monto: 0,
        nota: 'Sin facturación electrónica, un cliente más no aumenta ninguna factura',
      }],
      ganancia_por_cliente: mensualPropuesto,
      margen_pct: 100,
      escenarios: [5, 10, 25].map(n => ({
        clientes: n, ingreso: mensualPropuesto * n, costo: 0,
        ganancia: mensualPropuesto * n, nota: 'Sin costo variable',
      })),
      fijos: { ...fijos, clientes_para_cubrirlos: equilibrio(mensualPropuesto) },
    };
  }

  const veredicto = negociosEnRiesgo === 0
    ? `A ${money(mensualPropuesto)} no te quita clientes actuales y el costo de atenderlo es casi `
      + 'cero. El riesgo no está en los números sino en el soporte.'
    : perdida > eco.ingreso_mensual_total * 0.2
      ? `Cuidado: en el peor caso te costaría ${money(perdida)} por mes, que es más del 20% de lo `
        + 'que entra hoy. Si lo sacás, conviene que NO incluya lo que hace valioso al plan de arriba.'
      : `Se puede. En el peor caso resignás ${money(perdida)} por mes y lo recuperás con `
        + `${Math.ceil(perdida / mensualPropuesto)} clientes nuevos.`;

  return {
    entendido: { precio: precio!, ciclo: anual ? 'anual' : 'mensual', modulos },
    economia,
    numeros, bueno, malo, veredicto, no_puedo_saber: noPuedo,
  };
}
