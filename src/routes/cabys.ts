import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const cabys = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// Quita acentos y pasa a minúsculas para comparar/rankear.
const norm = (s: string) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * SUGERIR UN CABYS PARA CADA NOMBRE DE PRODUCTO.
 *
 * Para dar de alta a un cliente nuevo hay que ponerle CABYS a todo el catálogo
 * —y hoy hay 8.162 productos sin él—. Buscarlo a mano, producto por producto,
 * entre 20.506 códigos, es lo que hace que nadie lo haga: el cliente queda sin
 * poder facturar electrónicamente y nadie sabe bien por qué.
 *
 * Acá se resuelven TODOS los nombres de un archivo de una vez.
 *
 * ── Por qué en memoria y no una búsqueda por producto ─────────────────────
 * Una consulta por nombre son cientos de viajes a la base para un Excel
 * mediano: minutos de espera y un montón de carga para algo que se puede
 * hacer una sola vez. El catálogo entero son ~20.000 filas cortas; se carga
 * una vez, se indexa por palabra y cada nombre se resuelve en memoria.
 *
 * ── Cómo se decide ────────────────────────────────────────────────────────
 * Se comparan PALABRAS, no el texto completo: «Coca Cola 2.5 L» nunca va a ser
 * igual a ninguna descripción del catálogo, pero comparte «coca» y «cola» con
 * la correcta. Cada palabra pesa según lo rara que sea en el catálogo —«agua»
 * aparece en cientos de códigos y no distingue nada; «alcachofa» sí—, que es
 * lo que evita que todo caiga en el primer código genérico que comparte una
 * palabra común.
 *
 * La confianza sale de cuánto del nombre quedó explicado:
 *   alta  — prácticamente todo el nombre aparece en la descripción.
 *   media — la mitad o más: casi siempre bien, pero hay que mirarlo.
 *   baja  — poco y nada; no se propone nada, porque un CABYS equivocado cambia
 *           el IVA que se le cobra al cliente y eso es peor que no tener uno.
 */

/** Palabras que no distinguen nada y solo agregan ruido al emparejar. */
const VACIAS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'en', 'con',
  'sin', 'para', 'por', 'al', 'a', 'ml', 'lt', 'kg', 'gr', 'gs', 'cc', 'und',
  'unidad', 'unidades', 'paq', 'pack', 'caja', 'bolsa', 'x',
]);

const palabras = (texto: string): string[] =>
  norm(texto).replace(/[^a-z0-9ñ ]+/g, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && !VACIAS.has(w) && !/^\d+$/.test(w));

interface Catalogo {
  filas: Array<{ code: string; description: string; iva_rate: number | null; tokens: string[] }>;
  /** palabra → índices de las filas que la contienen. */
  indice: Map<string, number[]>;
  cargado: number;
}
let catalogo: Catalogo | null = null;
const CATALOGO_TTL = 30 * 60_000;   // media hora: el catálogo cambia una vez al año

/**
 * LO QUE YA CLASIFICARON LOS DEMÁS NEGOCIOS.
 *
 * El catálogo de Hacienda está escrito para mercadería: materias primas,
 * presentaciones, estados de conservación. Un restaurante no vende «carne de
 * cabra congelada», vende «Empanada de carne», y emparejar contra las
 * descripciones del catálogo manda ese plato a cualquier lado —medido:
 * «Empanada Carne» caía en «Carne de cabra» y «Arroz 1 kg» en «Harina de
 * arroz»—.
 *
 * Pero OTRO negocio ya clasificó ese mismo plato: hay 7.935 productos con
 * CABYS puesto, 7.564 nombres distintos, y «empanadas argentinas» ya está
 * resuelto como «Comidas preparadas». Emparejar contra nombres de productos
 * reales funciona mucho mejor que contra el catálogo, porque comparten el
 * vocabulario del mostrador y no el de la aduana.
 *
 * Qué se usa de los otros negocios: SOLO el nombre del producto y el código
 * CABYS. Nada de precios, ni costos, ni de qué negocio salió. Al que pregunta
 * se le dice el código y cuántos negocios lo usan, nunca cuáles.
 *
 * Se excluyen las demos (sus nombres son basura de prueba: «wdwd», «a1») y el
 * negocio que pregunta, para que «otros negocios» signifique eso.
 */
interface Corpus {
  /** nombre normalizado → código más usado para ese nombre. */
  exacto: Map<string, { code: string; negocios: number }>;
  /** Cada nombre ya clasificado, con sus palabras y su código. */
  filas: Array<{ tokens: string[]; code: string; negocios: number }>;
  /** palabra → índices de los nombres que la contienen. */
  indice: Map<string, number[]>;
  /** en cuántos nombres distintos aparece cada palabra (para el peso). */
  frecuencia: Map<string, number>;
  nombres: number;
  cargado: number;
}
let corpus: Corpus | null = null;
const CORPUS_TTL = 10 * 60_000;   // los negocios clasifican productos todos los días

async function cargarCorpus(): Promise<Corpus> {
  if (corpus && Date.now() - corpus.cargado < CORPUS_TTL) return corpus;

  const { data: tenants } = await db.from('tenants').select('id, is_demo');
  const demos = new Set(((tenants ?? []) as any[]).filter(t => t.is_demo).map(t => String(t.id)));

  /** nombre → código → cuántos negocios distintos lo usan así. */
  const porNombre = new Map<string, Map<string, Set<string>>>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('products')
      .select('tenant_id, name, cabys_code')
      .not('cabys_code', 'is', null)
      .order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const chunk = (data ?? []) as any[];
    for (const p of chunk) {
      const tid = String(p.tenant_id);
      if (demos.has(tid)) continue;
      const code = String(p.cabys_code ?? '').replace(/\D/g, '');
      const nombre = norm(String(p.name ?? '')).replace(/\s+/g, ' ').trim();
      if (!code || !nombre) continue;
      let m = porNombre.get(nombre);
      if (!m) { m = new Map(); porNombre.set(nombre, m); }
      let s = m.get(code);
      if (!s) { s = new Set(); m.set(code, s); }
      s.add(tid);
    }
    if (chunk.length < PAGE) break;
  }

  const exacto = new Map<string, { code: string; negocios: number }>();
  const filas: Corpus['filas'] = [];
  const indice = new Map<string, number[]>();
  const frecuencia = new Map<string, number>();
  for (const [nombre, m] of porNombre) {
    // Si dos negocios lo clasificaron distinto, gana el que más negocios usan.
    let mejorCode = '', mejorN = 0;
    for (const [code, negs] of m) {
      if (negs.size > mejorN) { mejorCode = code; mejorN = negs.size; }
    }
    if (!mejorCode) continue;
    exacto.set(nombre, { code: mejorCode, negocios: mejorN });
    const tokens = [...new Set(palabras(nombre))];
    if (tokens.length === 0) continue;
    const i = filas.push({ tokens, code: mejorCode, negocios: mejorN }) - 1;
    for (const w of tokens) {
      frecuencia.set(w, (frecuencia.get(w) ?? 0) + 1);
      const l = indice.get(w);
      if (l) l.push(i); else indice.set(w, [i]);
    }
  }
  corpus = { exacto, filas, indice, frecuencia, nombres: exacto.size, cargado: Date.now() };
  return corpus;
}

async function cargarCatalogo(): Promise<Catalogo> {
  if (catalogo && Date.now() - catalogo.cargado < CATALOGO_TTL) return catalogo;
  const filas: Catalogo['filas'] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('cabys_catalog')
      .select('code, description, iva_rate')
      .order('code', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const chunk = (data ?? []) as any[];
    for (const r of chunk) {
      filas.push({
        code: String(r.code), description: String(r.description ?? ''),
        iva_rate: r.iva_rate == null ? null : Number(r.iva_rate),
        tokens: palabras(String(r.description ?? '')),
      });
    }
    if (chunk.length < PAGE) break;
  }
  const indice = new Map<string, number[]>();
  filas.forEach((f, i) => {
    for (const t of new Set(f.tokens)) {
      const l = indice.get(t);
      if (l) l.push(i); else indice.set(t, [i]);
    }
  });
  catalogo = { filas, indice, cargado: Date.now() };
  return catalogo;
}

// POST /sugerir  { names: string[] } → una sugerencia por nombre.
cabys.post('/sugerir', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const nombres: string[] = Array.isArray(body?.names) ? body.names : [];
    if (nombres.length === 0) return ok(c, []);
    if (nombres.length > 3000) return fail(c, 'Demasiados productos de una vez (máximo 3000)', 422);

    const cat = await cargarCatalogo();
    const total = cat.filas.length || 1;
    const corp = await cargarCorpus();
    const tenantId = String(c.get('tenantId') ?? '');
    void tenantId;

    /** Descripción y tarifa de un código, para poder mostrar qué se eligió. */
    const infoDe = new Map(cat.filas.map(f => [f.code, f]));

    /**
     * Emparejar contra los nombres que otros negocios YA clasificaron.
     *
     * Primero el nombre exacto —si otro negocio vende lo mismo con el mismo
     * nombre, su código es la mejor respuesta que existe—. Si no, se suman los
     * códigos de todos los nombres que comparten palabras: «Empanada Carne»
     * comparte «empanada» con varios nombres ya resueltos, y todos apuntan al
     * mismo código de comidas preparadas. Sumar por CÓDIGO y no quedarse con un
     * solo nombre parecido es lo que lo vuelve estable.
     */
    const porOtrosNegocios = (nombre: string) => {
      const clave = norm(nombre).replace(/\s+/g, ' ').trim();
      const ex = corp.exacto.get(clave);
      if (ex) return { code: ex.code, parecido: 1, negocios: ex.negocios, exacto: true, margen: 1 };

      const tokens = [...new Set(palabras(nombre))];
      if (tokens.length === 0) return null;
      const pesoW = (w: string) => {
        const n = corp.frecuencia.get(w) ?? 0;
        return n === 0 ? 0 : Math.log((corp.nombres || 1) / n);
      };

      /**
       * Se busca el PRODUCTO más parecido, no el código más repetido.
       *
       * Sumando por código, el que más productos tiene se lleva todo: el
       * corpus tiene una veterinaria con decenas de artículos con «pollo», así
       * que «Casado con pollo» y «Pollo asado» terminaban en «Comida para
       * perros y gatos». Comparando nombre contra nombre eso no pasa, porque
       * «nutri source gato adulto pollo 15lb» tiene un montón de palabras que
       * el casado no tiene.
       *
       * El parecido se mide en los DOS sentidos (palabras compartidas sobre
       * palabras totales de ambos): así un nombre largo y distinto no gana solo
       * por compartir una palabra.
       */
      const candidatos = new Set<number>();
      for (const w of tokens) {
        for (const i of corp.indice.get(w) ?? []) candidatos.add(i);
        if (candidatos.size > 4000) break;      // palabras comunísimas: no hace falta más
      }
      if (candidatos.size === 0) return null;

      const pesoConsulta = tokens.reduce((a, w) => a + pesoW(w), 0);
      let mejor = -1, mejorP = 0, segundo = 0;
      for (const i of candidatos) {
        const f = corp.filas[i];
        let compartido = 0, union = pesoConsulta;
        const setConsulta = new Set(tokens);
        for (const w of f.tokens) {
          if (setConsulta.has(w)) compartido += pesoW(w);
          else union += pesoW(w);
        }
        if (compartido <= 0 || union <= 0) continue;
        const p = compartido / union;
        if (p > mejorP) { segundo = mejorP; mejor = i; mejorP = p; }
        else if (p > segundo) segundo = p;
      }
      if (mejor < 0) return null;
      return {
        code: corp.filas[mejor].code,
        parecido: mejorP,
        negocios: corp.filas[mejor].negocios,
        exacto: false,
        margen: mejorP > 0 ? (mejorP - segundo) / mejorP : 0,
      };
    };

    const salida = nombres.map((nombre) => {
      const tokens = [...new Set(palabras(String(nombre ?? '')))];
      const vacio = { name: nombre, code: null, description: null, iva_rate: null, confianza: 'baja' as const, fuente: null as string | null };
      if (tokens.length === 0) return vacio;

      // ── 1) Lo que ya clasificaron otros negocios ──
      const otros = porOtrosNegocios(String(nombre));
      if (otros) {
        // El nombre exacto es la señal más fuerte que hay. Para el resto se
        // pide que el nombre quede bien explicado Y que el código ganador se
        // despegue del segundo: un empate significa que no está claro.
        const conf = otros.exacto ? 'alta'
          : otros.parecido >= 0.6 ? 'alta'
          : otros.parecido >= 0.35 ? 'media'
          : null;
        if (conf) {
          const f = infoDe.get(otros.code);
          return {
            name: nombre, code: otros.code,
            description: f?.description ?? null,
            iva_rate: f?.iva_rate ?? null,
            confianza: conf as 'alta' | 'media',
            fuente: 'otros_negocios',
            negocios: otros.negocios || undefined,
            exacto: otros.exacto || undefined,
            parecido: Math.round(otros.parecido * 100),
          };
        }
      }

      // ── 2) Respaldo: el catálogo de Hacienda ──
      /**
       * Peso de una palabra en el CATÁLOGO: cuanto más rara, más distingue.
       *
       * Una palabra que NO está en el catálogo pesa MÁS que cualquiera, no
       * cero. Pesando cero desaparecía de la cuenta y «Empanada Carne» daba
       * 100% de coincidencia con «Carne de cabra», porque «empanada» —la
       * palabra que define el producto— se ignoraba.
       */
      const pesoMaximo = Math.log(total / 0.5);
      const peso = (w: string) => {
        const n = cat.indice.get(w)?.length ?? 0;
        return n === 0 ? pesoMaximo : Math.log(total / n);
      };
      const pesoTotal = tokens.reduce((s2, w) => s2 + peso(w), 0);
      if (pesoTotal <= 0) return vacio;

      // Solo se puntean las filas que comparten AL MENOS una palabra: recorrer
      // las 20.000 por cada producto sería tirar el tiempo en las que no tienen
      // ninguna posibilidad.
      const puntos = new Map<number, number>();
      for (const w of tokens) {
        const postings = cat.indice.get(w);
        if (!postings) continue;          // palabra ajena al catálogo: no suma a nadie
        const p = peso(w);
        for (const i of postings) puntos.set(i, (puntos.get(i) ?? 0) + p);
      }
      if (puntos.size === 0) return vacio;

      let mejor = -1, mejorPunto = 0;
      for (const [i, p] of puntos) {
        // A igual puntaje gana la descripción MÁS CORTA: es la más específica,
        // y las largas suelen ser cajones de sastre que mencionan de todo.
        if (p > mejorPunto || (p === mejorPunto && mejor >= 0
            && cat.filas[i].tokens.length < cat.filas[mejor].tokens.length)) {
          mejor = i; mejorPunto = p;
        }
      }
      if (mejor < 0) return vacio;

      const cobertura = mejorPunto / pesoTotal;      // cuánto del nombre quedó explicado
      const confianza = cobertura >= 0.85 ? 'alta' : cobertura >= 0.5 ? 'media' : 'baja';
      if (confianza === 'baja') return { ...vacio, name: nombre };

      const f = cat.filas[mejor];
      return {
        name: nombre, code: f.code, description: f.description,
        iva_rate: f.iva_rate, confianza,
        fuente: 'catalogo',
        cobertura: Math.round(cobertura * 100),
      };
    });

    return ok(c, salida);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /search?q=  — búsqueda global por código o descripción (todos los usuarios).
// Soporta multi-palabra: cada palabra debe aparecer (en cualquier orden) en la
// descripción. Los resultados se ordenan por relevancia.
cabys.get('/search', async (c) => {
  try {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) return ok(c, []);

    // Busca contra `col` (description_norm sin tildes, o description como respaldo).
    const runSearch = async (col: 'description_norm' | 'description') => {
      let query = db.from('cabys_catalog').select('code, description, iva_rate').limit(60);
      if (/^\d+$/.test(q)) {
        query = query.ilike('code', `${q}%`);            // código: por prefijo
      } else {
        // Cada palabra (≥2 letras) debe estar en la descripción (sin importar tildes).
        const words = norm(q).split(/\s+/).filter(w => w.length >= 2);
        for (const w of (words.length ? words : [norm(q)])) {
          query = query.ilike(col, `%${w}%`);
        }
      }
      return query;
    };

    // Preferimos la columna normalizada (sin tildes). Si aún no existe (migración 72
    // sin correr), caemos a la descripción original.
    let { data, error } = await (await runSearch('description_norm'));
    if (error && /description_norm/i.test(error.message)) {
      ({ data, error } = await (await runSearch('description')));
    }
    if (error) throw new Error(error.message);

    // Ranking: coincidencia exacta > empieza con > palabra al inicio > contiene.
    const nq = norm(q);
    const words = nq.split(/\s+/).filter(Boolean);
    const score = (r: any) => {
      const d = norm(r.description);
      if (d === nq) return 0;
      if (d.startsWith(nq)) return 1;
      if (words.every(w => new RegExp(`\\b${w}`).test(d))) return 2;  // cada palabra al inicio de alguna palabra
      return 3;
    };
    const ranked = (data ?? []).slice().sort((a, b) => {
      const sa = score(a), sb = score(b);
      if (sa !== sb) return sa - sb;
      return norm(a.description).length - norm(b.description).length;  // más corto = más específico
    });
    return ok(c, ranked.slice(0, 30));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /count — cuántos códigos hay cargados.
cabys.get('/count', async (c) => {
  try {
    const { count } = await db.from('cabys_catalog').select('code', { count: 'exact', head: true });
    return ok(c, { count: count ?? 0 });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// POST /bulk — carga masiva (super-admin, desde el Excel). body: { rows: [{code, description, iva_rate, sheet}] }
cabys.post('/bulk', async (c) => {
  try {
    const b = await c.req.json();
    const rows: any[] = Array.isArray(b.rows) ? b.rows : [];
    const clean = rows
      .filter(r => r?.code && r?.description)
      .map(r => {
        const description = String(r.description).trim().slice(0, 500);
        return {
          code: String(r.code).trim(),
          description,
          description_norm: norm(description),   // sin tildes, para buscar (migración 72)
          iva_rate: Number.isFinite(Number(r.iva_rate)) ? Number(r.iva_rate) : 13,
          sheet: r.sheet ?? 'catalogo',
          updated_at: new Date().toISOString(),
        };
      });
    if (clean.length === 0) return ok(c, { inserted: 0 });
    let { error } = await db.from('cabys_catalog').upsert(clean, { onConflict: 'code' });
    // Si la columna description_norm aún no existe (migración 72 sin correr), reintentar sin ella.
    if (error && /description_norm/i.test(error.message)) {
      const stripped = clean.map(({ description_norm, ...r }: any) => r);
      ({ error } = await db.from('cabys_catalog').upsert(stripped, { onConflict: 'code' }));
    }
    if (error) throw new Error(error.message);
    return ok(c, { inserted: clean.length });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// DELETE / — vaciar el catálogo (para recargar).
cabys.delete('/', async (c) => {
  try {
    const { error } = await db.from('cabys_catalog').delete().neq('code', '');
    if (error) throw new Error(error.message);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default cabys;
