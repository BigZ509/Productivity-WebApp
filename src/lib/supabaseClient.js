import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const hasSupabaseEnv = Boolean(supabaseUrl && supabaseAnonKey)
export const supabaseEnvError = hasSupabaseEnv
  ? ''
  : 'Supabase env vars are missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the project root .env file.'

const lockNoOp = async (_name, _acquireTimeout, fn) => fn()

export const supabase = hasSupabaseEnv
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        lock: lockNoOp,
        lockAcquireTimeout: 0,
      },
    })
  : null
