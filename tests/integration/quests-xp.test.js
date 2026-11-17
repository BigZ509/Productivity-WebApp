import { afterAll, describe, expect, it } from 'vitest'
import {
  admin,
  cleanupUsers,
  createUser,
  expectHint,
  integrationEnabled,
  ledgerSum,
  profileXp,
  questByTitle,
  questsForPath,
} from './helpers'

describe.skipIf(!integrationEnabled)('quest lifecycle and XP integrity (local Supabase)', () => {
  afterAll(cleanupUsers)

  it('accepts a quest and lists it as active', async () => {
    const { client, userId } = await createUser()
    const quest = await questByTitle('HUNTER', 'Fix 2 Bugs')
    const res = await client.rpc('accept_quest', { p_quest_id: quest.id })
    expect(res.error).toBeNull()
    expect(res.data[0]).toMatchObject({ quest_id: quest.id, status: 'active', already_active: false })

    const active = await client.from('user_active_quests').select('id, status').eq('user_id', userId).eq('status', 'active')
    expect(active.data).toHaveLength(1)
  })

  it('selecting the same quest twice returns the same active instance', async () => {
    const { client, userId } = await createUser()
    const quest = await questByTitle('HUNTER', 'Write 3 Tests')
    const a = await client.rpc('accept_quest', { p_quest_id: quest.id })
    const b = await client.rpc('accept_quest', { p_quest_id: quest.id })
    expect(b.data[0].active_quest_id).toBe(a.data[0].active_quest_id)
    expect(b.data[0].already_active).toBe(true)
    const { count } = await admin.from('user_active_quests').select('id', { count: 'exact', head: true }).eq('user_id', userId)
    expect(count).toBe(1)
  })

  it('enforces the active limit server-side, even under concurrent accepts', async () => {
    const { client, userId } = await createUser()
    const quests = await questsForPath('HUNTER', 8)
    const results = await Promise.all(quests.map((q) => client.rpc('accept_quest', { p_quest_id: q.id })))
    const ok = results.filter((r) => !r.error)
    const limited = results.filter((r) => r.error?.hint === 'QUEST_LIMIT')
    expect(ok).toHaveLength(5)
    expect(limited).toHaveLength(3)
    const { count } = await admin
      .from('user_active_quests')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'active')
    expect(count).toBe(5)
  })

  it('rejects quests from another path', async () => {
    const { client } = await createUser({ path: 'HUNTER' })
    const demonQuest = (await questsForPath('HEAVENLY_DEMON', 1))[0]
    expectHint(await client.rpc('accept_quest', { p_quest_id: demonQuest.id }), 'QUEST_UNAVAILABLE')
  })

  it('completes a quest and awards its XP exactly once, including retries', async () => {
    const { client, userId } = await createUser()
    const quest = await questByTitle('HUNTER', 'Deep Study 60m')
    const accepted = await client.rpc('accept_quest', { p_quest_id: quest.id })
    const instanceId = accepted.data[0].active_quest_id

    const first = await client.rpc('complete_active_quest', { p_active_quest_id: instanceId, p_note: 'Finished chapter 4' })
    expect(first.error).toBeNull()
    expect(first.data[0]).toMatchObject({ xp_awarded: quest.xp_reward, newly_completed: true, xp_total: quest.xp_reward })

    // Retry after a "lost response": same result, no extra XP.
    const retry = await client.rpc('complete_active_quest', { p_active_quest_id: instanceId })
    expect(retry.data[0]).toMatchObject({ newly_completed: false, xp_total: quest.xp_reward })

    expect(await profileXp(client)).toBe(quest.xp_reward)
    expect(await ledgerSum(userId)).toBe(quest.xp_reward)

    const history = await client.from('quest_completions').select('note, xp_awarded').eq('active_quest_id', instanceId).single()
    expect(history.data).toEqual({ note: 'Finished chapter 4', xp_awarded: quest.xp_reward })
  })

  it('awards once under 10 concurrent completion attempts', async () => {
    const { client, userId } = await createUser()
    const quest = await questByTitle('HUNTER', 'Ship 1 Small Feature')
    const instanceId = (await client.rpc('accept_quest', { p_quest_id: quest.id })).data[0].active_quest_id

    const results = await Promise.all(
      Array.from({ length: 10 }, () => client.rpc('complete_active_quest', { p_active_quest_id: instanceId })),
    )
    expect(results.every((r) => !r.error)).toBe(true)
    expect(results.filter((r) => r.data[0].newly_completed)).toHaveLength(1)
    expect(await profileXp(client)).toBe(quest.xp_reward)
    expect(await ledgerSum(userId)).toBe(quest.xp_reward)
  })

  it('does not let another user complete my quest', async () => {
    const owner = await createUser()
    const attacker = await createUser()
    const quest = await questByTitle('HUNTER', 'Refactor 1 Module')
    const instanceId = (await owner.client.rpc('accept_quest', { p_quest_id: quest.id })).data[0].active_quest_id

    expectHint(await attacker.client.rpc('complete_active_quest', { p_active_quest_id: instanceId }), 'QUEST_NOT_FOUND')
    expect(await profileXp(attacker.client)).toBe(0)
    expect(await profileXp(owner.client)).toBe(0)
  })

  it('blocks re-accepting a completed quest during its cooldown (no fresh reward)', async () => {
    const { client } = await createUser()
    const quest = await questByTitle('HUNTER', 'Teach-Back Drill')
    const instanceId = (await client.rpc('accept_quest', { p_quest_id: quest.id })).data[0].active_quest_id
    await client.rpc('complete_active_quest', { p_active_quest_id: instanceId })
    expectHint(await client.rpc('accept_quest', { p_quest_id: quest.id }), 'QUEST_COOLDOWN')
    // Completing the old instance again is still a no-op.
    const again = await client.rpc('complete_active_quest', { p_active_quest_id: instanceId })
    expect(again.data[0].newly_completed).toBe(false)
    expect(await profileXp(client)).toBe(quest.xp_reward)
  })

  it('models repeatable quests as separate instances with separate rewards', async () => {
    const title = `Repeatable test ${Date.now()}`
    const ins = await admin
      .from('quests')
      .insert({ title, path: 'HUNTER', category: 'study', difficulty: 'easy', xp_reward: 10, is_active: true, repeat_cooldown_hours: 0 })
      .select()
      .single()
    try {
      const { client, userId } = await createUser()
      const first = (await client.rpc('accept_quest', { p_quest_id: ins.data.id })).data[0].active_quest_id
      await client.rpc('complete_active_quest', { p_active_quest_id: first })
      const second = (await client.rpc('accept_quest', { p_quest_id: ins.data.id })).data[0].active_quest_id
      expect(second).not.toBe(first)
      await client.rpc('complete_active_quest', { p_active_quest_id: second })
      expect(await profileXp(client)).toBe(20)
      expect(await ledgerSum(userId)).toBe(20)
    } finally {
      await admin.from('quests').delete().eq('id', ins.data.id)
    }
  })

  it('abandoning frees a slot and can never award XP', async () => {
    const { client } = await createUser()
    const quest = await questByTitle('HUNTER', 'Code Sprint 90m')
    const instanceId = (await client.rpc('accept_quest', { p_quest_id: quest.id })).data[0].active_quest_id
    expect((await client.rpc('abandon_active_quest', { p_active_quest_id: instanceId })).error).toBeNull()
    expectHint(await client.rpc('complete_active_quest', { p_active_quest_id: instanceId }), 'QUEST_ABANDONED')
    expect(await profileXp(client)).toBe(0)
  })
})
