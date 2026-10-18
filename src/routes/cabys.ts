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

/**
 * La RAÍZ de una palabra, para que singular y plural sean la misma.
 *
 * El catálogo de Hacienda está escrito en plural («Tornillos de hierro o
 * acero») y la gente nombra sus productos en singular («Tornillo galvanizado
 * 3/8»). Sin esto no se cruzaban NUNCA: ese tornillo quedaba sin código
 * aunque el catálogo tenga seis filas de tornillos, y la persona terminaba
 * buscando a mano entre veinte mil líneas.
 *
 * Se corta la «s» final y después una «e» final, que es lo que vuelve
 * simétricos los dos plurales del español:
 *   tornillo / tornillos   → tornillo
 *   carne    / carnes      → carn
 *   animal   / animales    → animal
 *
 * Las palabras de tres letras no se tocan: «res», «gas» y «mes» no son
 * plurales de nada y mutilarlas crearía cruces falsos.
 */
const raiz = (w: string): string => {
  if (w.length <= 3) return w;
  let r = w.endsWith('s') ? w.slice(0, -1) : w;
  if (r.length > 4 && r.endsWith('e')) r = r.slice(0, -1);
  return r;
};

const palabras = (texto: string): string[] =>
  norm(texto).replace(/[^a-z0-9ñ ]+/g, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && !VACIAS.has(w) && !/^\d+$/.test(w))
    .map(raiz);

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
/**
 * EL MOTOR DE SUGERENCIA, aparte del endpoint.
 *
 * Lo usan dos pantallas —el importador masivo y el asistente de IA— y tiene
 * que ser el MISMO. Si cada una tuviera su copia, en seis meses una tendría
 * los arreglos y la otra no, y el mismo producto recibiría códigos distintos
 * según por dónde se entró. Para Hacienda esa inconsistencia es del negocio,
 * no del sistema.
 */
export async function sugerirCabys(
  nombres: string[],
  opciones: { alternativas?: boolean } = {},
): Promise<any[]> {
  {
    const cat = await cargarCatalogo();
    const total = cat.filas.length || 1;
    const corp = await cargarCorpus();

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

    /**
     * Las OTRAS opciones razonables, no solo la ganadora.
     *
     * Quien revisa necesita poder decir «esa no, esta otra» sin salir a buscar
     * en veinte mil filas. Se calculan solo cuando alguien las pide: para una
     * importación de mil productos nadie las mira y costarían tiempo de más.
     */
    const alternativasDelCatalogo = (tokens: string[], excluir: string | null) => {
      const pesoMax = Math.log(total / 0.5);
      const peso = (w: string) => {
        const n = cat.indice.get(w)?.length ?? 0;
        return n === 0 ? pesoMax : Math.log(total / n);
      };
      const pesoTotal = tokens.reduce((a, w) => a + peso(w), 0) || 1;
      const puntos = new Map<number, number>();
      for (const w of tokens) {
        const postings = cat.indice.get(w);
        if (!postings) continue;
        const pw = peso(w);
        for (const i of postings) puntos.set(i, (puntos.get(i) ?? 0) + pw);
      }
      return [...puntos.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([i, pt]) => ({
          code: cat.filas[i].code,
          description: cat.filas[i].description,
          iva_rate: cat.filas[i].iva_rate,
          coincidencia: Math.round((pt / pesoTotal) * 100),
        }))
        .filter(x => x.code !== excluir)
        .slice(0, 3);
    };

    /**
     * El mejor candidato del CATÁLOGO OFICIAL de Hacienda.
     *
     * Antes esto vivía suelto dentro del map y solo se ejecutaba cuando el
     * corpus de otros negocios fallaba. Ahora es una función aparte porque
     * hace falta poder CONSULTARLO para decidir, no solo como respaldo: una
     * coincidencia floja con lo que clasificó un negocio no debería ganarle a
     * una buena del catálogo oficial.
     */
    const mejorDelCatalogo = (tokens: string[]) => {
      /**
       * Peso de una palabra: cuanto más rara, más distingue.
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
      if (pesoTotal <= 0) return null;

      // Solo se puntean las filas que comparten AL MENOS una palabra: recorrer
      // las 20.000 por cada producto sería tirar el tiempo en las que no tienen
      // ninguna posibilidad.
      const puntos = new Map<number, number>();
      for (const w of tokens) {
        const postings = cat.indice.get(w);
        if (!postings) continue;          // palabra ajena al catálogo: no suma a nadie
        const pw = peso(w);
        for (const i of postings) puntos.set(i, (puntos.get(i) ?? 0) + pw);
      }
      if (puntos.size === 0) return null;

      let mejor = -1, mejorPunto = 0;
      for (const [i, pt] of puntos) {
        // A igual puntaje gana la descripción MÁS CORTA: es la más específica,
        // y las largas suelen ser cajones de sastre que mencionan de todo.
        if (pt > mejorPunto || (pt === mejorPunto && mejor >= 0
            && cat.filas[i].tokens.length < cat.filas[mejor].tokens.length)) {
          mejor = i; mejorPunto = pt;
        }
      }
      if (mejor < 0) return null;
      const f = cat.filas[mejor];
      return {
        code: f.code, description: f.description, iva_rate: f.iva_rate,
        cobertura: mejorPunto / pesoTotal,              // cuánto del nombre quedó explicado
        compartidas: tokens.filter(w => f.tokens.includes(w)),
      };
    };

    const salida = nombres.map((nombre) => {
      const tokens = [...new Set(palabras(String(nombre ?? '')))];
      const vacio = { name: nombre, code: null, description: null, iva_rate: null, confianza: 'baja' as const, fuente: null as string | null };
      if (tokens.length === 0) return vacio;

      const alt = (excluir: string | null) =>
        (opciones.alternativas ? alternativasDelCatalogo(tokens, excluir) : undefined);

      const deCatalogo = (m: NonNullable<ReturnType<typeof mejorDelCatalogo>>, conf: 'alta' | 'media') => ({
        name: nombre, code: m.code, description: m.description, iva_rate: m.iva_rate,
        confianza: conf, fuente: 'catalogo',
        cobertura: Math.round(m.cobertura * 100),
        motivo: m.compartidas.length
          ? `La descripción oficial comparte ${m.compartidas.length === 1 ? 'la palabra' : 'las palabras'} `
            + m.compartidas.slice(0, 4).map(w => '«' + w + '»').join(', ')
            + ` y explica un ${Math.round(m.cobertura * 100)}% del nombre.`
          : `Del catálogo oficial de Hacienda, con un ${Math.round(m.cobertura * 100)}% de coincidencia.`,
        alternativas: alt(m.code),
      });

      // ── 1) Lo que ya clasificaron otros negocios ──
      const otros = porOtrosNegocios(String(nombre));
      if (otros) {
        const f = infoDe.get(otros.code);
        const resultadoCorpus = (conf: 'alta' | 'media') => ({
          name: nombre, code: otros.code,
          description: f?.description ?? null,
          iva_rate: f?.iva_rate ?? null,
          confianza: conf,
          fuente: 'otros_negocios',
          negocios: otros.negocios || undefined,
          exacto: otros.exacto || undefined,
          parecido: Math.round(otros.parecido * 100),
          motivo: otros.exacto
            ? `${otros.negocios || 'Otro'} negocio(s) venden un producto con este mismo nombre y le pusieron este código.`
            : `Se parece un ${Math.round(otros.parecido * 100)}% a un producto que ya clasificó otro negocio.`,
          alternativas: alt(otros.code),
        });

        // El nombre EXACTO es la señal más fuerte que existe: otro negocio
        // vende literalmente esto y ya resolvió el código.
        if (otros.exacto || otros.parecido >= 0.6) return resultadoCorpus('alta');

        /**
         * Zona dudosa: se le pregunta también al catálogo oficial.
         *
         * Una coincidencia floja con lo que clasificó UN negocio no puede
         * ganarle a una buena del catálogo. Medido: «Cuaderno rayado 100
         * hojas» se parecía un 46% a un producto que un negocio clasificó como
         * «Hoja de laurel procesada», y eso le ganaba al 62% de «Cuaderno de
         * 25, 50 y 100 hojas» del catálogo. El error no era solo de código:
         * el laurel paga 13% de IVA y el cuaderno escolar paga 1%.
         */
        if (otros.parecido >= 0.35) {
          const m = mejorDelCatalogo(tokens);
          /**
           * Para desplazar al corpus, al catálogo no le alcanza con puntuar
           * más: tiene que explicar la MAYORÍA del nombre.
           *
           * Sin esa segunda condición ganaba compartiendo una sola palabra
           * genérica, y el resultado era peor que lo que reemplazaba —medido—:
           *   «Llanta de moto»  → «Motos acuáticas»   (en vez de llantas de motocicleta)
           *   «Papa en malla»   → «Malla Mersilene»   (en vez de papa fresca)
           * En los dos casos compartía 1 de 2 palabras. El cuaderno, que sí
           * corresponde cambiar, comparte 2 de 3.
           */
          const explicaLaMayoria = m ? m.compartidas.length / tokens.length >= 0.6 : false;
          if (m && explicaLaMayoria && m.cobertura > otros.parecido) {
            return deCatalogo(m, m.cobertura >= 0.85 ? 'alta' : 'media');
          }
          return resultadoCorpus('media');
        }
      }

      // ── 2) Respaldo: el catálogo de Hacienda ──
      const m = mejorDelCatalogo(tokens);
      if (!m) return vacio;
      const confianza = m.cobertura >= 0.85 ? 'alta' : m.cobertura >= 0.5 ? 'media' : 'baja';
      /**
       * Poca confianza: NO se pone código, pero sí se ofrecen las opciones.
       *
       * Antes acá se devolvía un vacío absoluto, y eso dejaba a la persona sin
       * nada justo donde más ayuda necesita: «Tornillo galvanizado 3/8»
       * terminaba sin código y sin pista, igual que un nombre sin sentido.
       * Poner el código a ciegas sería peor —lo paga el negocio ante
       * Hacienda—, pero mostrar las tres opciones más cercanas convierte una
       * búsqueda a mano entre veinte mil filas en un clic entre tres.
       */
      if (confianza === 'baja') {
        return {
          ...vacio, name: nombre,
          motivo: 'Ninguna opción queda lo bastante clara como para ponerla sola '
            + `(la mejor explica apenas un ${Math.round(m.cobertura * 100)}% del nombre). Elegí vos:`,
          alternativas: alt(null),
        };
      }
      return deCatalogo(m, confianza);
    });

    return salida;
  }
}

cabys.post('/sugerir', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const nombres: string[] = Array.isArray(body?.names) ? body.names : [];
    if (nombres.length === 0) return ok(c, []);
    if (nombres.length > 3000) return fail(c, 'Demasiados productos de una vez (máximo 3000)', 422);
    return ok(c, await sugerirCabys(nombres));
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
