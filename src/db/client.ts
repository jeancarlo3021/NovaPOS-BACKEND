import { createClient } from '@supabase/supabase-js';

const url     = process.env.SUPABASE_URL;
const srvKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !srvKey || !anonKey) {
  throw new Error(
    `Missing Supabase env vars: ${[
      !url     && 'SUPABASE_URL',
      !srvKey  && 'SUPABASE_SERVICE_ROLE_KEY',
      !anonKey && 'SUPABASE_ANON_KEY',
    ].filter(Boolean).join(', ')}`
  );
}

// Abort any Supabase call that takes longer than 8 s (safely under Vercel's 10 s limit)
const fetchWithTimeout: typeof fetch = (input, init) => {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
};

// Admin client — bypasses all RLS
export const db = createClient(url, srvKey, {
  auth:   { autoRefreshToken: false, persistSession: false },
  global: { fetch: fetchWithTimeout },
});

// Anon client — used only to verify user JWTs
export const anonClient = createClient(url, anonKey, {
  global: { fetch: fetchWithTimeout },
});
