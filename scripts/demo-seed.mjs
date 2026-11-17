#!/usr/bin/env node
// ZBXP demo fixtures: deterministic, resettable, isolated.
//
// Creates (or, with --reset, recreates) ONLY these accounts:
//   - the demo Hunter (email/password from DEMO_USER_EMAIL / DEMO_USER_PASSWORD)
//   - three synthetic guildmates (demo-rival-N@<demo domain>, random passwords
//     that are never printed: nobody logs in as them)
// and their data: quest history, active quests, workouts, focus sessions,
// a public guild and a leaderboard. No other users or rows are touched.
//
// Usage:
//   DEMO_USER_EMAIL=... DEMO_USER_PASSWORD=... node scripts/demo-seed.mjs [--reset]
//
// Target: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (falls back to the local
// stack values in .env.test.local). Non-local targets require --remote AND
// DEMO_ALLOW_REMOTE=yes, and should only ever be a dedicated QA/demo project.
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const args = new Set(process.argv.slice(2))
const env = { ...process.env }
const localEnv = new URL('../.env.test.local', import.meta.url)
if (existsSync(localEnv)) {
  for (const line of readFileSync(localEnv, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/)
    if (m && !env[m[1]]) env[m[1]] = m[2]
  }
}

const url = env.SUPABASE_URL || env.SUPABASE_TEST_URL
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_TEST_SERVICE_ROLE_KEY
const demoEmail = env.DEMO_USER_EMAIL
const demoPassword = env.DEMO_USER_PASSWORD
const demoDomain = (demoEmail || '').split('@')[1] || 'zbxp.demo'

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

if (!url || !serviceKey) fail('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or run the local stack).')
if (!demoEmail || !demoPassword) fail('Set DEMO_USER_EMAIL and DEMO_USER_PASSWORD. Credentials are never stored in the repo.')
if (demoPassword.length < 12) fail('DEMO_USER_PASSWORD must be at least 12 characters.')

const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url)
if (!isLocal && !(args.has('--remote') && env.DEMO_ALLOW_REMOTE === 'yes')) {
  fail(`Refusing to seed non-local target ${new URL(url).host}. Use a dedicated QA project with --remote and DEMO_ALLOW_REMOTE=yes.`)
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

const DAY = 86400000
const ago = (days, hour = 10) => {
  const d = new Date(Date.now() - days * DAY)
  d.setUTCHours(hour, 0, 0, 0)
  return d
}
const isoDate = (d) => d.toISOString().slice(0, 10)

const DEMO = {
  name: 'Kai Ardent',
  path: 'HUNTER',
  // [quest title, days ago] → completed history. Sums with workouts/focus to 470 XP,
  // so the demo quest ("Ship 1 Small Feature", +42) crosses into D-rank and level 6.
  completed: [
    ['Fix 2 Bugs', 9],
    ['Read 20 Pages + Notes', 8],
    ['Deep Study 60m', 7],
    ['Write 3 Tests', 6],
    ['Follow-Ups x10', 5],
    ['Teach-Back Drill', 4],
    ['Refactor 1 Module', 3],
    ['Flashcards 30 Reps', 2],
    ['Code Sprint 90m', 1],
  ],
  active: ['Research Synthesis', 'Prospect Outreach x15'],
  workouts: [6, 4, 2, 1],
  focus: [{ daysAgo: 3, minutes: 50 }, { daysAgo: 1, minutes: 25 }],
}

const RIVALS = [
  { key: 1, name: 'Mira Vance', weekly: [['Ship 1 Small Feature', 0], ['Fix 2 Bugs', 1]], older: 380 },
  { key: 2, name: 'Theo Graves', weekly: [['Deep Study 60m', 0]], older: 610 },
  { key: 3, name: 'Juno Park', weekly: [], older: 140 },
]

async function must(promise, what) {
  const { data, error } = await promise
  if (error) fail(`${what}: ${error.message}`)
  return data
}

async function findUserByEmail(email) {
  for (let page = 1; page < 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) fail(`listUsers: ${error.message}`)
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
    if (hit) return hit
    if (data.users.length < 200) return null
  }
  return null
}

async function ensureUser(email, password) {
  const existing = await findUserByEmail(email)
  if (existing) {
    if (args.has('--reset')) {
      await must(admin.auth.admin.deleteUser(existing.id), `delete ${email}`)
    } else {
      await must(admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true }), `update ${email}`)
      return { user: existing, fresh: false }
    }
  }
  const data = await must(admin.auth.admin.createUser({ email, password, email_confirm: true }), `create ${email}`)
  return { user: data.user, fresh: true }
}

const questCache = new Map()
async function quest(path, title) {
  const key = `${path}:${title}`
  if (!questCache.has(key)) {
    const q = await must(admin.from('quests').select('id, xp_reward, title').eq('path', path).eq('title', title).single(), `quest ${title}`)
    questCache.set(key, q)
  }
  return questCache.get(key)
}

async function addCompletion(userId, path, title, when) {
  const q = await quest(path, title)
  const inst = await must(
    admin
      .from('user_active_quests')
      .insert({ user_id: userId, quest_id: q.id, status: 'completed', selected_at: new Date(when - 3600000).toISOString(), completed_at: when.toISOString() })
      .select('id')
      .single(),
    'history instance',
  )
  await must(admin.from('quest_completions').insert({ active_quest_id: inst.id, user_id: userId, xp_awarded: q.xp_reward, completed_at: when.toISOString() }), 'completion')
  await must(admin.from('xp_events').insert({ user_id: userId, source_type: 'quest', source_id: inst.id, amount: q.xp_reward, created_at: when.toISOString() }), 'xp event')
  return q.xp_reward
}

async function syncBalance(userId) {
  const rows = await must(admin.from('xp_events').select('amount').eq('user_id', userId), 'ledger')
  const total = rows.reduce((s, r) => s + r.amount, 0)
  await must(admin.from('profiles').update({ xp_total: total }).eq('id', userId), 'balance')
  return total
}

async function seedProfile(userId, name, path) {
  await must(
    admin.from('profiles').upsert({ id: userId, username: name, display_name: name, path }, { onConflict: 'id' }),
    'profile',
  )
}

async function main() {
  console.log(`→ Seeding demo fixtures into ${isLocal ? 'LOCAL stack' : new URL(url).host}${args.has('--reset') ? ' (reset)' : ''}`)

  const { user: demo, fresh } = await ensureUser(demoEmail, demoPassword)
  if (!fresh && !args.has('--reset')) {
    console.log('  Demo user already exists; run with --reset to rebuild fixtures from scratch.')
    return
  }
  await seedProfile(demo.id, DEMO.name, DEMO.path)

  let xp = 0
  for (const [title, daysAgo] of DEMO.completed) xp += await addCompletion(demo.id, DEMO.path, title, ago(daysAgo))
  for (const daysAgo of DEMO.workouts) {
    const log = await must(
      admin.from('workout_logs').insert({ user_id: demo.id, log_date: isoDate(ago(daysAgo)), completed: true, payload: { notes: 'Demo session' } }).select('id').single(),
      'workout',
    )
    await must(admin.from('xp_events').insert({ user_id: demo.id, source_type: 'workout', source_id: log.id, amount: 40, created_at: ago(daysAgo, 18).toISOString() }), 'workout xp')
    xp += 40
  }
  for (const f of DEMO.focus) {
    const s = await must(
      admin
        .from('focus_sessions')
        .insert({
          user_id: demo.id,
          planned_seconds: f.minutes * 60,
          focused_seconds: f.minutes * 60,
          status: 'completed',
          started_at: ago(f.daysAgo, 14).toISOString(),
          ended_at: new Date(ago(f.daysAgo, 14).getTime() + f.minutes * 60000).toISOString(),
          xp_awarded: Math.floor(f.minutes / 5),
        })
        .select('id')
        .single(),
      'focus',
    )
    await must(admin.from('xp_events').insert({ user_id: demo.id, source_type: 'focus', source_id: s.id, amount: Math.floor(f.minutes / 5), created_at: ago(f.daysAgo, 15).toISOString() }), 'focus xp')
    xp += Math.floor(f.minutes / 5)
  }
  // Top up to exactly 470 with one older completion-free carry-over so the demo
  // rank-up moment is deterministic regardless of seed quest rewards.
  if (xp < 470) {
    await must(
      admin.from('xp_events').insert({ user_id: demo.id, source_type: 'reconciliation', source_id: demo.id, amount: 470 - xp, created_at: ago(20).toISOString(), note: 'Demo starting balance' }),
      'starting balance',
    )
  }
  for (const title of DEMO.active) {
    const q = await quest(DEMO.path, title)
    await must(admin.from('user_active_quests').insert({ user_id: demo.id, quest_id: q.id, status: 'active', selected_at: ago(0, 8).toISOString() }), 'active quest')
  }
  await must(admin.rpc('_recalculate_workout_streak', { p_user_id: demo.id }), 'streak')
  const demoTotal = await syncBalance(demo.id)

  // Guild + rivals
  const guild = await must(
    admin
      .from('groups')
      .insert({ name: 'Midnight Raiders', created_by: demo.id, invite_code: randomBytes(4).toString('hex').toUpperCase(), description: 'Demo guild: ship before sunrise.', visibility: 'public' })
      .select('id, invite_code')
      .single(),
    'guild',
  )
  await must(admin.from('group_members').insert({ group_id: guild.id, user_id: demo.id, role: 'owner', joined_at: ago(14).toISOString() }), 'owner membership')

  for (const r of RIVALS) {
    const email = `demo-rival-${r.key}@${demoDomain}`
    const { user } = await ensureUser(email, randomBytes(24).toString('base64url'))
    await seedProfile(user.id, r.name, 'HUNTER')
    for (const [title, daysAgo] of r.weekly) await addCompletion(user.id, 'HUNTER', title, ago(daysAgo, 9))
    await must(
      admin.from('xp_events').insert({ user_id: user.id, source_type: 'reconciliation', source_id: user.id, amount: r.older, created_at: ago(30).toISOString(), note: 'Demo starting balance' }),
      'rival balance',
    )
    await syncBalance(user.id)
    await must(admin.from('group_members').insert({ group_id: guild.id, user_id: user.id, role: 'member', joined_at: ago(10).toISOString() }), 'rival membership')
  }

  console.log(`✓ Demo Hunter "${DEMO.name}" ready: ${demoTotal} XP, ${DEMO.active.length} active quests, guild "Midnight Raiders" (code ${guild.invite_code}).`)
  console.log('  Demo quest: accept "Ship 1 Small Feature" (+42 XP) to trigger the D-rank / level 6 moment.')
}

main().catch((e) => fail(e.message))
