import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const hasSupabaseEnv = Boolean(supabaseUrl && supabaseAnonKey)
export const supabaseEnvError = hasSupabaseEnv
  ? ''
  : 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'

// The previous build replaced the auth client's cross-tab lock with a no-op to
// work around deadlocks. The real cause was awaiting Supabase calls inside
// onAuthStateChange (see AuthProvider), which is now fixed, so the default
// navigator.locks-based lock is restored: it prevents two tabs from refreshing
// the same session concurrently.
export const supabase = hasSupabaseEnv
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null
