import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Corte por consulta. Bajo a propósito: ver abajo por qué. */
const QUERY_TIMEOUT_MS = 6_000;

/**
 * Una consulta, con corte de tiempo y UN reintento si el fallo fue pasajero.
 *
 * ── Por qué el reintento ───────────────────────────────────────────────────
 * La base falla de a ratos por su cuenta: rachas donde ~3 % de las lecturas se
 * caen y vuelven solas al minuto. El problema es DÓNDE pegan: `users`,
 * `tenants` y `subscriptions` se consultan en CADA petición del sistema, así
 * que ese 3 % no afecta al 3 % de las pantallas — afecta al 3 % de TODO, y el
 * usuario ve errores al azar en cualquier lugar sin ningún patrón.
 *
 * Un solo reintento convierte casi todo eso en éxito, porque las rachas duran
 * milisegundos, no segundos.
 *
 * ── Solo LECTURAS ──────────────────────────────────────────────────────────
 * Reintentar una escritura que quizá sí entró duplicaría facturas o pagos. Las
 * escrituras fallan y se avisan, que es lo correcto.
 *
 * ── Por qué 6 segundos y no más ────────────────────────────────────────────
 * El servidor entero se corta a los 30 s. Un handler que hace cuatro consultas
 * colgadas de 8 s se pasa de ese techo y muere sin decir nada —el «Task timed
 * out after 30 seconds»—. Con 6 s más un reintento, el peor caso de una
 * consulta son 12 s y todavía queda margen para contestar algo.
 */
const fetchWithTimeout: typeof fetch = async (input, init) => {
  const metodo = String((init as any)?.method ?? 'GET').toUpperCase();
  const esLectura = metodo === 'GET' || metodo === 'HEAD';

  const intentar = async (): Promise<Response> => {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), QUERY_TIMEOUT_MS);
    try {
      return await fetch(input, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const r = await intentar();
    // 5xx en una lectura también es pasajero: la base contestó, pero mal.
    if (!esLectura || r.status < 500) return r;
    await new Promise(res => setTimeout(res, 150 + Math.random() * 200));
    return await intentar();
  } catch (e) {
    if (!esLectura) throw e;
    // Se cortó o no hubo respuesta: un segundo intento, con una pausa mínima
    // para no caer justo en el mismo bache.
    await new Promise(res => setTimeout(res, 150 + Math.random() * 200));
    return await intentar();
  }
};

// Lazy singleton — module loads fine even without env vars (health check works)
function lazyClient(factory: () => SupabaseClient): SupabaseClient {
  let instance: SupabaseClient | null = null;
  return new Proxy({} as SupabaseClient, {
    get(_, prop) {
      if (!instance) instance = factory();
      const value = (instance as any)[prop as string];
      return typeof value === 'function' ? value.bind(instance) : value;
    },
  });
}

export const db = lazyClient(() =>
  createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: fetchWithTimeout } }
  )
);

export const anonClient = lazyClient(() =>
  createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  )
);
