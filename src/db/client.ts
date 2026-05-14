import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Admin client — bypasses all RLS
export const db = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Anon client — used only to verify user JWTs
export const anonClient = createClient(url, process.env.SUPABASE_ANON_KEY!);
