import { afterAll, describe, expect, it } from 'vitest'
import { admin, anonClient, cleanupUsers, createUser, expectHint, integrationEnabled, profileXp, questByTitle } from './helpers'

describe.skipIf(!integrationEnabled)('guilds (local Supabase)', () => {
  afterAll(cleanupUsers)

  it('create → join by code → duplicate join → member-only leaderboard', async () => {
    const owner = await createUser({ name: 'Owner One' })
    const member = await createUser({ name: 'Member Two' })
    const outsider = await createUser({ name: 'Outsider' })

    const created = await owner.client.rpc('guild_create', { p_name: `Night Shift ${Date.now()}`, p_description: 'Test', p_visibility: 'public' })
    expect(created.error).toBeNull()
    const { group_id: groupId, invite_code: code } = created.data[0]

    const mine = await owner.client.rpc('guild_my_guilds')
    expect(mine.data[0]).toMatchObject({ group_id: groupId, role: 'owner', invite_code: code, member_count: 1 })

    // Invite codes are not readable through the table API by anyone.
    const leak = await member.client.from('groups').select('invite_code').eq('id', groupId)
    expect(leak.error).not.toBeNull()
    const listed = await member.client.rpc('guild_list_public', { p_search: 'Night Shift' })
    expect(listed.data.some((g) => g.group_id === groupId)).toBe(true)
    expect(Object.keys(listed.data[0])).not.toContain('invite_code')

    expectHint(await outsider.client.rpc('guild_leaderboard', { p_group_id: groupId, p_timeframe: 'weekly' }), 'NOT_A_MEMBER')

    const join = await member.client.rpc('guild_join_by_code', { p_code: code.toLowerCase() })
    expect(join.data[0]).toMatchObject({ group_id: groupId, joined: true })
    const dup = await member.client.rpc('guild_join_by_code', { p_code: code })
    expect(dup.data[0].joined).toBe(false)
    const { count } = await admin.from('group_members').select('user_id', { count: 'exact', head: true }).eq('group_id', groupId)
    expect(count).toBe(2)

    // Earn XP, then check the leaderboard agrees with each profile.
    const quest = await questByTitle('HUNTER', 'Fix 2 Bugs')
    const inst = (await member.client.rpc('accept_quest', { p_quest_id: quest.id })).data[0].active_quest_id
    await member.client.rpc('complete_active_quest', { p_active_quest_id: inst })

    const board = await owner.client.rpc('guild_leaderboard', { p_group_id: groupId, p_timeframe: 'all_time' })
    expect(board.error).toBeNull()
    expect(board.data).toHaveLength(2)
    for (const row of board.data) {
      expect(row).not.toHaveProperty('user_id')
      expect(row).not.toHaveProperty('email')
    }
    const memberRow = board.data.find((r) => r.display_name === 'Member Two')
    expect(memberRow).toMatchObject({ standing: 1, xp: quest.xp_reward, is_self: false })
    expect(memberRow.total_xp).toBe(await profileXp(member.client))
    expect(board.data.find((r) => r.display_name === 'Owner One').is_self).toBe(true)

    const weekly = await member.client.rpc('guild_leaderboard', { p_group_id: groupId, p_timeframe: 'weekly' })
    expect(weekly.data.find((r) => r.is_self).xp).toBe(quest.xp_reward)
  })

  it('private guilds are hidden and only joinable by code', async () => {
    const owner = await createUser()
    const other = await createUser()
    const created = await owner.client.rpc('guild_create', { p_name: `Hidden ${Date.now()}`, p_visibility: 'private' })
    const { group_id: groupId, invite_code: code } = created.data[0]

    const listed = await other.client.rpc('guild_list_public', { p_search: 'Hidden' })
    expect(listed.data.some((g) => g.group_id === groupId)).toBe(false)
    const direct = await other.client.from('groups').select('id, name').eq('id', groupId)
    expect(direct.data).toEqual([])
    expectHint(await other.client.rpc('guild_join_public', { p_group_id: groupId }), 'GUILD_NOT_PUBLIC')
    expect((await other.client.rpc('guild_join_by_code', { p_code: code })).data[0].joined).toBe(true)
  })

  it('blocks direct membership writes and bad codes', async () => {
    const owner = await createUser()
    const other = await createUser()
    const groupId = (await owner.client.rpc('guild_create', { p_name: `Locked ${Date.now()}` })).data[0].group_id
    const direct = await other.client.from('group_members').insert({ group_id: groupId, user_id: other.userId, role: 'owner' })
    expect(direct.error).not.toBeNull()
    const promote = await owner.client.from('group_members').update({ role: 'owner' }).eq('group_id', groupId)
    expect(promote.error).not.toBeNull()
    expectHint(await other.client.rpc('guild_join_by_code', { p_code: 'NOPE0000' }), 'INVALID_CODE')
    expectHint(await other.client.rpc('guild_join_by_code', { p_code: "x' or 1=1" }), 'INVALID_CODE')
    expectHint(await owner.client.rpc('guild_create', { p_name: 'ab' }), 'INVALID_NAME')
  })

  it('transfers ownership when the owner leaves', async () => {
    const owner = await createUser()
    const member = await createUser()
    const { group_id: groupId, invite_code: code } = (await owner.client.rpc('guild_create', { p_name: `Relay ${Date.now()}` })).data[0]
    await member.client.rpc('guild_join_by_code', { p_code: code })
    await owner.client.rpc('guild_leave', { p_group_id: groupId })
    const mine = await member.client.rpc('guild_my_guilds')
    expect(mine.data.find((g) => g.group_id === groupId).role).toBe('owner')
  })
})

describe.skipIf(!integrationEnabled)('authentication (local Supabase Auth)', () => {
  afterAll(cleanupUsers)

  it('signs in, restores a returning session, refreshes, and signs out', async () => {
    const { email, password } = await createUser()
    const store = new Map()
    const storage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    }
    const tab1 = anonClient({ auth: { persistSession: true, storage } })
    const signIn = await tab1.auth.signInWithPassword({ email, password })
    expect(signIn.error).toBeNull()

    // A second client sharing storage = a returning visit / another tab.
    const tab2 = anonClient({ auth: { persistSession: true, storage } })
    const restored = await tab2.auth.getSession()
    expect(restored.data.session?.user.email).toBe(email)
    expect((await tab2.rpc('ensure_profile')).error).toBeNull()

    const oldRefresh = signIn.data.session.refresh_token
    const refreshed = await tab1.auth.refreshSession()
    expect(refreshed.error).toBeNull()
    expect(refreshed.data.session.refresh_token).not.toBe(oldRefresh)

    await tab1.auth.signOut()
    expect((await tab1.auth.getSession()).data.session).toBeNull()
    const reuse = await anonClient().auth.refreshSession({ refresh_token: refreshed.data.session.refresh_token })
    expect(reuse.error).not.toBeNull()
  })

  it('rejects a wrong password without creating anything', async () => {
    const { email } = await createUser()
    const res = await anonClient().auth.signInWithPassword({ email, password: 'definitely-wrong' })
    expect(res.error?.message).toMatch(/invalid login credentials/i)
  })
})
