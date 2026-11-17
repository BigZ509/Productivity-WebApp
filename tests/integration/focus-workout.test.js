import { afterAll, describe, expect, it } from 'vitest'
import { admin, cleanupUsers, createUser, expectHint, integrationEnabled, ledgerSum, profileXp, questByTitle } from './helpers'

async function backdate(sessionId, seconds) {
  const startedAt = new Date(Date.now() - seconds * 1000).toISOString()
  const { error } = await admin.from('focus_sessions').update({ started_at: startedAt }).eq('id', sessionId)
  if (error) throw error
}

function localDate(offsetDays = 0) {
  // Server current_date is UTC; use UTC dates so the window check is deterministic.
  const d = new Date(Date.now() + offsetDays * 86400000)
  return d.toISOString().slice(0, 10)
}

describe.skipIf(!integrationEnabled)('focus sessions (local Supabase)', () => {
  afterAll(cleanupUsers)

  it('starts a server-timed session linked to an active quest', async () => {
    const { client, userId } = await createUser()
    const quest = await questByTitle('HUNTER', 'Fix 2 Bugs')
    const inst = (await client.rpc('accept_quest', { p_quest_id: quest.id })).data[0].active_quest_id
    const res = await client.rpc('start_focus_session', { p_planned_seconds: 1500, p_active_quest_id: inst })
    expect(res.error).toBeNull()
    const row = await admin.from('focus_sessions').select('*').eq('id', res.data[0].session_id).single()
    expect(row.data).toMatchObject({ user_id: userId, status: 'running', active_quest_id: inst, planned_seconds: 1500 })
  })

  it('refuses completion before real time has elapsed (timer manipulation)', async () => {
    const { client } = await createUser()
    const id = (await client.rpc('start_focus_session', { p_planned_seconds: 1500 })).data[0].session_id
    expectHint(await client.rpc('complete_focus_session', { p_session_id: id, p_focused_seconds: 1500 }), 'FOCUS_TOO_FAST')
    expectHint(await client.rpc('complete_focus_session', { p_session_id: id, p_focused_seconds: 30 }), 'FOCUS_INCOMPLETE')
    expect(await profileXp(client)).toBe(0)
  })

  it('completes after the planned time, awards once, and retries are idempotent', async () => {
    const { client, userId } = await createUser()
    const id = (await client.rpc('start_focus_session', { p_planned_seconds: 1500 })).data[0].session_id
    await backdate(id, 1510)
    const done = await client.rpc('complete_focus_session', { p_session_id: id, p_focused_seconds: 1500 })
    expect(done.error).toBeNull()
    expect(done.data[0]).toMatchObject({ xp_awarded: 5, newly_completed: true, focused_seconds: 1500 })
    const retry = await client.rpc('complete_focus_session', { p_session_id: id, p_focused_seconds: 1500 })
    expect(retry.data[0]).toMatchObject({ xp_awarded: 5, newly_completed: false })
    expect(await profileXp(client)).toBe(5)
    expect(await ledgerSum(userId)).toBe(5)
  })

  it('allows only one running session; starting another supersedes it', async () => {
    const { client, userId } = await createUser()
    const first = (await client.rpc('start_focus_session', { p_planned_seconds: 600 })).data[0].session_id
    const second = (await client.rpc('start_focus_session', { p_planned_seconds: 600 })).data[0].session_id
    const rows = await admin.from('focus_sessions').select('id, status').eq('user_id', userId)
    expect(rows.data.find((r) => r.id === first).status).toBe('abandoned')
    expect(rows.data.find((r) => r.id === second).status).toBe('running')
    await backdate(first, 700)
    expectHint(await client.rpc('complete_focus_session', { p_session_id: first, p_focused_seconds: 600 }), 'FOCUS_NOT_RUNNING')
  })

  it('caps focus XP per day', async () => {
    const { client } = await createUser()
    const long = (await client.rpc('start_focus_session', { p_planned_seconds: 14400 })).data[0].session_id
    await backdate(long, 14410)
    expect((await client.rpc('complete_focus_session', { p_session_id: long, p_focused_seconds: 14400 })).data[0].xp_awarded).toBe(48)
    const more = (await client.rpc('start_focus_session', { p_planned_seconds: 1500 })).data[0].session_id
    await backdate(more, 1510)
    const capped = await client.rpc('complete_focus_session', { p_session_id: more, p_focused_seconds: 1500 })
    expect(capped.data[0]).toMatchObject({ xp_awarded: 0, newly_completed: true })
    expect(await profileXp(client)).toBe(48)
  })

  it('cancelled and foreign sessions cannot be completed', async () => {
    const a = await createUser()
    const b = await createUser()
    const id = (await a.client.rpc('start_focus_session', { p_planned_seconds: 600 })).data[0].session_id
    await backdate(id, 700)
    expectHint(await b.client.rpc('complete_focus_session', { p_session_id: id, p_focused_seconds: 600 }), 'FOCUS_NOT_FOUND')
    await a.client.rpc('cancel_focus_session', { p_session_id: id })
    expectHint(await a.client.rpc('complete_focus_session', { p_session_id: id, p_focused_seconds: 600 }), 'FOCUS_NOT_RUNNING')
  })
})

describe.skipIf(!integrationEnabled)('workouts (local Supabase)', () => {
  afterAll(cleanupUsers)

  it('awards workout XP once per day with bonuses, and tracks the streak', async () => {
    const { client, userId } = await createUser()
    const first = await client.rpc('record_workout', {
      p_date: localDate(0),
      p_completed: true,
      p_payload: { bonus_walk_45: true, bonus_run_45: true, notes: 'push day' },
    })
    expect(first.error).toBeNull()
    expect(first.data[0]).toMatchObject({ xp_awarded: 65, bonus_xp: 25, current_streak: 1 })

    const again = await client.rpc('record_workout', { p_date: localDate(0), p_completed: true, p_payload: {} })
    expect(again.data[0].xp_awarded).toBe(0)

    const yesterday = await client.rpc('record_workout', { p_date: localDate(-1), p_completed: true, p_payload: {} })
    expect(yesterday.data[0]).toMatchObject({ xp_awarded: 40, current_streak: 2 })
    expect(await profileXp(client)).toBe(105)
    expect(await ledgerSum(userId)).toBe(105)
  })

  it('rejects back-dated workouts outside the logging window', async () => {
    const { client } = await createUser()
    expectHint(await client.rpc('record_workout', { p_date: localDate(-10), p_completed: true, p_payload: {} }), 'WORKOUT_DATE')
    expect(await profileXp(client)).toBe(0)
  })
})
