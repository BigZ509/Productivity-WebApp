// Integration test helpers. These tests run ONLY against a local Supabase
// stack (`npx supabase start`); configuration is read from .env.test.local,
// which is git-ignored. They refuse to run against a non-local URL.
import { readFileSync, existsSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function loadEnv() {
  const env = { ...process.env }
  const file = new URL('../../.env.test.local', import.meta.url)
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/)
      if (m && !env[m[1]]) env[m[1]] = m[2]
    }
  }
  return env
}

const env = loadEnv()
export const TEST_URL = env.SUPABASE_TEST_URL
const ANON = env.SUPABASE_TEST_ANON_KEY
const SERVICE = env.SUPABASE_TEST_SERVICE_ROLE_KEY

const isLocal = Boolean(TEST_URL && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(TEST_URL))
export const integrationEnabled = Boolean(isLocal && ANON && SERVICE)

const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

export const admin = integrationEnabled ? createClient(TEST_URL, SERVICE, noPersist) : null

export function anonClient(options = {}) {
  return createClient(TEST_URL, ANON, { ...noPersist, ...options, auth: { ...noPersist.auth, ...(options.auth || {}) } })
}

const created = []

export async function createUser({ path = 'HUNTER', name } = {}) {
  const email = `t-${randomUUID().slice(0, 12)}@zbxp.test`
  const password = randomBytes(18).toString('base64url')
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  created.push(data.user.id)
  const client = anonClient()
  const signIn = await client.auth.signInWithPassword({ email, password })
  if (signIn.error) throw signIn.error
  if (path) {
    const res = await client.rpc('set_identity', { p_display_name: name || `Tester${created.length}`, p_path: path })
    if (res.error) throw res.error
  }
  return { client, userId: data.user.id, email, password }
}

export async function cleanupUsers() {
  while (created.length) {
    const id = created.pop()
    await admin.auth.admin.deleteUser(id)
  }
}

export async function profileXp(client) {
  const { data, error } = await client.rpc('ensure_profile')
  if (error) throw error
  return data[0].xp_total
}

export async function ledgerSum(userId) {
  const { data, error } = await admin.from('xp_events').select('amount').eq('user_id', userId)
  if (error) throw error
  return data.reduce((s, r) => s + r.amount, 0)
}

export async function questByTitle(path, title) {
  const { data, error } = await admin.from('quests').select('*').eq('path', path).eq('title', title).single()
  if (error) throw error
  return data
}

export async function questsForPath(path, n) {
  const { data, error } = await admin.from('quests').select('*').eq('path', path).eq('is_active', true).limit(n)
  if (error) throw error
  return data
}

export function expectHint(res, hint) {
  if (!res.error) throw new Error(`Expected error ${hint}, got success: ${JSON.stringify(res.data)}`)
  if (res.error.hint !== hint) throw new Error(`Expected hint ${hint}, got ${res.error.hint}: ${res.error.message}`)
}
