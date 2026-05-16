import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const fetchWithTimeout: typeof fetch = (input, init) => {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
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
