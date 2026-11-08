import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `${name} is required. Set it in .env.local and Vercel project env.`
    );
  }
  return v;
}

let _supabase: SupabaseClient | null = null;

/** Lazy anon client — avoids crashing `next build` when env is absent at import time. */
export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    );
  }
  return _supabase;
}

/** Back-compat: same lazy behavior for existing `supabase.from(...)` call sites. */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = getSupabase();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
