import { afterAll, describe, expect, it } from 'vitest'
import { admin, anonClient, cleanupUsers, createUser, expectHint, integrationEnabled, profileXp, questByTitle } from './helpers'

describe.skipIf(!integrationEnabled)('access control (local Supabase)', () => {
  afterAll(cleanupUsers)

  it('users cannot grant themselves XP or change privileged profile fields directly', async () => {
    const { client, userId } = await createUser()
    const upd = await client.from('profiles').update({ xp_total: 99999, total_xp: 99999 }).eq('id', userId).select()
    expect(upd.error).not.toBeNull()
    const streak = await client.from('profiles').update({ current_streak: 365 }).eq('id', userId).select()
    expect(streak.error).not.toBeNull()
    const name = await client.from('profiles').update({ display_name: 'hacker' }).eq('id', userId).select()
    expect(name.error).not.toBeNull()
    expect(await profileXp(client)).toBe(0)
  })

  it('users cannot write ledger, quest, completion or membership rows directly', async () => {
    const { client, userId } = await createUser()
    const quest = await questByTitle('HUNTER', 'Fix 2 Bugs')
    const fakeId = crypto.randomUUID()
    const attempts = await Promise.all([
      client.from('xp_events').insert({ user_id: userId, source_type: 'quest', source_id: fakeId, amount: 500 }),
      client.from('user_active_quests').insert({ user_id: userId, quest_id: quest.id, status: 'active' }),
      client.from('quest_completions').insert({ user_id: userId, active_quest_id: fakeId }),
      client.from('workout_logs').insert({ user_id: userId, log_date: '2026-01-01', completed: true }),
      client.from('focus_sessions').insert({ user_id: userId, planned_seconds: 600 }),
    ])
    for (const res of attempts) expect(res.error).not.toBeNull()
    expect(await profileXp(client)).toBe(0)
  })

  it('legacy and internal functions are not callable by signed-in users', async () => {
    const { client, userId } = await createUser()
    const quest = await questByTitle('HUNTER', 'Fix 2 Bugs')
    const calls = await Promise.all([
      client.rpc('_award_xp', { p_user_id: userId, p_source_type: 'quest', p_source_id: crypto.randomUUID(), p_amount: 1000 }),
      client.rpc('select_quest', { p_quest_id: quest.id }),
      client.rpc('complete_quest', { p_active_quest_id: crypto.randomUUID(), p_optional_note: null }),
      client.rpc('recalculate_streaks', { p_user_id: userId }),
      client.rpc('get_leaderboard', { p_group_id: crypto.randomUUID(), p_timeframe: 'weekly' }),
      client.rpc('log_workout', { p_date: '2026-01-01', p_completed: true, p_optional_payload: {} }),
    ])
    for (const res of calls) expect(res.error).not.toBeNull()
    expect(await profileXp(client)).toBe(0)
  })

  it('anonymous callers can neither read data nor call the API', async () => {
    const anon = anonClient()
    const quest = await questByTitle('HUNTER', 'Fix 2 Bugs')
    expect((await anon.rpc('accept_quest', { p_quest_id: quest.id })).error).not.toBeNull()
    expect((await anon.rpc('recalculate_streaks', { p_user_id: crypto.randomUUID() })).error).not.toBeNull()
    const profiles = await anon.from('profiles').select('id').limit(1)
    expect(profiles.error || profiles.data.length === 0).toBeTruthy()
    const groups = await anon.from('groups').select('id').limit(1)
    expect(groups.error || groups.data.length === 0).toBeTruthy()
  })

  it('users only see their own profile and ledger', async () => {
    const a = await createUser()
    const b = await createUser()
    const quest = await questByTitle('HUNTER', 'Fix 2 Bugs')
    const inst = (await b.client.rpc('accept_quest', { p_quest_id: quest.id })).data[0].active_quest_id
    await b.client.rpc('complete_active_quest', { p_active_quest_id: inst })

    const theirProfile = await a.client.from('profiles').select('*').eq('id', b.userId)
    expect(theirProfile.data).toEqual([])
    const theirLedger = await a.client.from('xp_events').select('*').eq('user_id', b.userId)
    expect(theirLedger.data).toEqual([])
    const theirQuests = await a.client.from('user_active_quests').select('*').eq('user_id', b.userId)
    expect(theirQuests.data).toEqual([])
  })

  it('validates identity input server-side', async () => {
    const { client } = await createUser({ path: null })
    expectHint(await client.rpc('set_identity', { p_display_name: 'me@example.com', p_path: 'HUNTER' }), 'INVALID_NAME')
    expectHint(await client.rpc('set_identity', { p_display_name: 'x', p_path: 'HUNTER' }), 'INVALID_NAME')
    expectHint(await client.rpc('set_identity', { p_display_name: 'Valid Name', p_path: 'WIZARD' }), 'INVALID_PATH')
    expect((await client.rpc('set_identity', { p_display_name: 'Valid Name', p_path: 'HEAVENLY_DEMON' })).error).toBeNull()
  })

  it('new accounts start un-onboarded with zero XP', async () => {
    const { client } = await createUser({ path: null })
    const { data } = await client.rpc('ensure_profile')
    expect(data[0]).toMatchObject({ path: null, xp_total: 0 })
    expect(data[0].display_name).toMatch(/^Hunter#/)
  })

  it('cannot link someone else’s focus session to a completion', async () => {
    const a = await createUser()
    const b = await createUser()
    const session = (await b.client.rpc('start_focus_session', { p_planned_seconds: 600 })).data[0].session_id
    const quest = await questByTitle('HUNTER', 'Fix 2 Bugs')
    const inst = (await a.client.rpc('accept_quest', { p_quest_id: quest.id })).data[0].active_quest_id
    await a.client.rpc('complete_active_quest', { p_active_quest_id: inst, p_focus_session_id: session })
    const row = await admin.from('quest_completions').select('focus_session_id').eq('active_quest_id', inst).single()
    expect(row.data.focus_session_id).toBeNull()
  })
})
