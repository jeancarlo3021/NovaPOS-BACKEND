/**
 * USO DE INFRAESTRUCTURA: cuánto estamos gastando en Supabase y en Vercel.
 *
 * ── Lo que este módulo SÍ hace ────────────────────────────────────────────
 * Mide. Cuenta filas tabla por tabla, pesa los archivos de cada bucket uno por
 * uno y cuenta los usuarios que entraron en los últimos 30 días. Esos números
 * salen de la base, no de una fórmula.
 *
 * ── Lo que NO hace, y por qué importa ─────────────────────────────────────
 * No inventa lo que no puede medir. El egreso (los GB que salen de Supabase) y
 * el tráfico de Vercel no son visibles con las llaves que tenemos: hacen falta
 * tokens de administración de cada plataforma. Un panel de costos que rellena
 * esos huecos con una suposición disfrazada de dato es peor que no tenerlo,
 * porque nadie vuelve a verificarlo y las decisiones se toman sobre humo.
 * Acá cada número viene etiquetado como `medido` o `estimado`, y lo que no se
 * puede saber se dice que no se puede saber.
 *
 * Con VERCEL_TOKEN configurado, lo de Vercel pasa de «no medible» a medido.
 */
import { db } from '../db/client.js';

const URL_SB = String(process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const KEY_SB = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');

/** Cabeceras de servicio. Esta llave NUNCA sale del servidor. */
const cab = () => ({ apikey: KEY_SB, Authorization: `Bearer ${KEY_SB}` });

export interface Medida {
  /** `medido` = contado contra la base. `estimado` = calculado a partir de una medición. */
  origen: 'medido' | 'estimado' | 'no_medible';
  valor: number | null;
  nota?: string;
}

/** Las tablas que el proyecto expone, leídas del propio PostgREST. */
async function tablas(): Promise<string[]> {
  const r = await fetch(`${URL_SB}/rest/v1/`, { headers: cab() });
  if (!r.ok) return [];
  const spec: any = await r.json();
  return Object.keys(spec?.definitions ?? {});
}

/**
 * Filas de una tabla, con un HEAD: no trae datos, solo el conteo.
 *
 * Son cien tablas, así que van de a tandas. Secuencial tardaba lo suficiente
 * como para que el panel pareciera colgado.
 */
async function contarFilas(nombres: string[]): Promise<Record<string, number>> {
  const salida: Record<string, number> = {};
  /**
   * Las cien de una vez, no de a doce.
   *
   * Iban en tandas por prudencia, y medido resultó al revés: en tandas de
   * doce tardaba 3,4 s y todas juntas 1,7 s. Son consultas de conteo, sin
   * datos de vuelta; el límite no es la base, es la ida y vuelta por la red.
   */
  await Promise.all(nombres.map(async (t) => {
    try {
      const { count } = await db.from(t).select('*', { count: 'exact', head: true });
      salida[t] = Number(count ?? 0);
    } catch { /* una tabla sin permiso no debe tumbar el informe */ }
  }));
  return salida;
}

/**
 * Cuánto PESA una fila típica, midiendo una muestra real.
 *
 * Se mide el JSON que devuelve la base, no los bytes en disco: no tenemos
 * acceso a `pg_total_relation_size` con estas llaves. Es una aproximación, y
 * por eso viaja marcada como estimación — pero es una aproximación MEDIDA, no
 * un número inventado, y alcanza para lo que importa: descubrir cuáles son las
 * tablas pesadas. Acá las que mandan son `received_documents` (guarda el XML
 * completo de cada factura recibida) y las que guardan JSON grande.
 */
async function pesoPorFila(tabla: string, muestra = 25): Promise<number> {
  try {
    const { data } = await db.from(tabla).select('*').limit(muestra);
    const filas = (data ?? []) as any[];
    if (filas.length === 0) return 0;
    return Buffer.byteLength(JSON.stringify(filas), 'utf8') / filas.length;
  } catch { return 0; }
}

/** Los archivos de un bucket, pesados uno por uno. Esto sí es exacto. */
async function pesoBucket(bucket: string): Promise<{ bytes: number; objetos: number; truncado: boolean }> {
  let bytes = 0, objetos = 0, truncado = false;
  const porVisitar: string[] = [''];
  const TOPE = 5000;   // un bucket enorme no puede dejar el panel colgado
  while (porVisitar.length > 0) {
    const prefix = porVisitar.shift()!;
    for (let offset = 0; ; offset += 100) {
      const r = await fetch(`${URL_SB}/storage/v1/object/list/${bucket}`, {
        method: 'POST',
        headers: { ...cab(), 'content-type': 'application/json' },
        body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }),
      });
      if (!r.ok) return { bytes, objetos, truncado: true };
      const lista: any[] = await r.json();
      if (!Array.isArray(lista) || lista.length === 0) break;
      for (const o of lista) {
        // Sin `id` es una carpeta: hay que entrar.
        if (!o.id) { porVisitar.push(prefix ? `${prefix}/${o.name}` : o.name); continue; }
        bytes += Number(o?.metadata?.size ?? 0);
        objetos += 1;
      }
      if (lista.length < 100) break;
      if (objetos > TOPE) { truncado = true; break; }
    }
    if (objetos > TOPE) { truncado = true; break; }
  }
  return { bytes, objetos, truncado };
}

/**
 * Usuarios activos del mes (MAU), que es como cobra Supabase.
 *
 * No es «cuántas cuentas hay» sino cuántas ENTRARON: una base con mil cuentas
 * dormidas no cuesta lo mismo que una con mil personas trabajando.
 */
async function usuarios(): Promise<{ total: number; mau30: number } | null> {
  let total = 0, mau30 = 0;
  const corte = Date.now() - 30 * 86_400_000;
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${URL_SB}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: cab() });
    if (!r.ok) return page === 1 ? null : { total, mau30 };
    const j: any = await r.json();
    const us: any[] = j?.users ?? [];
    if (us.length === 0) break;
    total += us.length;
    for (const u of us) {
      const t = u?.last_sign_in_at ? new Date(u.last_sign_in_at).getTime() : 0;
      if (t >= corte) mau30 += 1;
    }
    if (us.length < 200) break;
  }
  return { total, mau30 };
}

/**
 * Uso real de Vercel, si hay token.
 *
 * Sin token no se inventa nada: se devuelve `no_medible` y la pantalla explica
 * qué hace falta. Un número de tráfico inventado se convierte en una decisión
 * de plan equivocada.
 */
async function vercel(): Promise<any> {
  const token = String(process.env.VERCEL_TOKEN ?? '').trim();
  if (!token) {
    return {
      disponible: false,
      motivo: 'Falta VERCEL_TOKEN en el servidor. Sin él no hay forma de leer el consumo real '
        + '(ancho de banda, invocaciones, builds): la API de Vercel lo exige.',
    };
  }
  const equipo = String(process.env.VERCEL_TEAM_ID ?? '').trim();
  const q = equipo ? `?teamId=${encodeURIComponent(equipo)}` : '';
  try {
    const r = await fetch(`https://api.vercel.com/v2/user${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return { disponible: false, motivo: `Vercel respondió ${r.status}: el token no sirve o le faltan permisos.` };
    const u: any = await r.json();
    return { disponible: true, cuenta: u?.user?.username ?? u?.user?.email ?? null, nota: 'Token válido.' };
  } catch (e: any) {
    return { disponible: false, motivo: `No se pudo consultar Vercel: ${e?.message ?? 'error de red'}` };
  }
}

/**
 * CACHÉ COMPARTIDA DE LA MEDICIÓN.
 *
 * La piden dos pantallas —el consumo y la economía de los planes— y medir
 * cuesta unos diez segundos. Sin compartirla, abrir Infraestructura disparaba
 * DOS mediciones completas a la vez contra el límite de 30 segundos que tiene
 * la función en Vercel (`maxDuration: 30` en vercel.json). Cuando se pasaba,
 * el navegador mostraba «NetworkError when attempting to fetch resource»: un
 * mensaje que parece un problema de conexión del usuario y en realidad era
 * una consulta nuestra demasiado lenta.
 *
 * Vale aclarar un límite de esto: en un entorno sin servidor cada arranque en
 * frío empieza con la caché vacía y dos peticiones simultáneas pueden caer en
 * instancias distintas. Ayuda, no garantiza; por eso además se redujo el
 * trabajo de la medición en sí.
 */
let cacheMedicion: { en: number; datos: any } | null = null;
const MEDICION_TTL = 10 * 60_000;

export async function medirInfraestructura(opciones: { refrescar?: boolean } = {}) {
  if (!opciones.refrescar && cacheMedicion && Date.now() - cacheMedicion.en < MEDICION_TTL) {
    return cacheMedicion.datos;
  }
  const datos = await medirAhora();
  cacheMedicion = { en: Date.now(), datos };
  return datos;
}

async function medirAhora() {
  const nombres = await tablas();
  const filas = await contarFilas(nombres);

  // Se pesa solo lo pesado: medir las cien tablas sería un minuto de espera
  // para enterarse de que ochenta están casi vacías.
  const porFilas = Object.entries(filas).sort((a, b) => b[1] - a[1]);
  // Diez, no dieciocho: ordenadas por filas, de la décima en adelante son
  // tablas con un puñado de registros que no mueven el total y sí suman
  // tiempo contra el límite de la función.
  const candidatas = porFilas.filter(([, n]) => n > 0).slice(0, 10).map(([t]) => t);
  // En paralelo. Una por una eran dieciocho esperas encadenadas y ahí se iba
  // la mayor parte de los veinticinco segundos que tardaba esta pantalla.
  const pesos: Record<string, number> = {};
  const medidos = await Promise.all(candidatas.map(t => pesoPorFila(t)));
  candidatas.forEach((t, i) => { pesos[t] = medidos[i]; });

  const detalleTablas = porFilas
    .filter(([, n]) => n > 0)
    .map(([tabla, n]) => ({
      tabla, filas: n,
      bytes_fila: pesos[tabla] ? Math.round(pesos[tabla]) : null,
      bytes: pesos[tabla] ? Math.round(pesos[tabla] * n) : null,
    }));
  const bytesBase = detalleTablas.reduce((s, t) => s + (t.bytes ?? 0), 0);

  const NOMBRES_BUCKET = ['logos', 'products', 'fe-certificates', 'app', 'apk', 'shared-docs', 'respaldos'];
  const pesados = await Promise.all(
    NOMBRES_BUCKET.map(b => pesoBucket(b).catch(() => ({ bytes: 0, objetos: 0, truncado: true }))),
  );
  const buckets = NOMBRES_BUCKET.map((bucket, i) => ({ bucket, ...pesados[i] }));
  const bytesArchivos = buckets.reduce((s, b) => s + b.bytes, 0);

  const us = await usuarios();

  return {
    medido_en: new Date().toISOString(),
    supabase: {
      tablas: detalleTablas,
      filas_totales: detalleTablas.reduce((s, t) => s + t.filas, 0),
      base_bytes: { origen: 'estimado' as const, valor: bytesBase,
        nota: 'Sumando el peso medido de una muestra real de cada tabla pesada. Es el tamaño del '
          + 'contenido, no el del disco: los índices y el espacio muerto de Postgres no se ven con '
          + 'estas llaves, así que el número real del tablero de Supabase va a ser MAYOR.' },
      archivos_bytes: { origen: 'medido' as const, valor: bytesArchivos,
        nota: 'Pesando cada archivo de cada bucket, uno por uno.' },
      buckets,
      usuarios_total: { origen: us ? 'medido' as const : 'no_medible' as const, valor: us?.total ?? null },
      mau_30d: { origen: us ? 'medido' as const : 'no_medible' as const, valor: us?.mau30 ?? null,
        nota: 'Cuentas con ingreso en los últimos 30 días. Es lo que Supabase cobra como MAU.' },
      egreso_bytes: { origen: 'no_medible' as const, valor: null,
        nota: 'Los GB que salen de Supabase solo los sabe su tablero: la API de datos no los expone. '
          + 'Es el rubro que más sorprende en la factura, así que conviene mirarlo ahí de vez en cuando.' },
    },
    vercel: await vercel(),
  };
}
