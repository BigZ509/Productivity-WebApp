import { supabase } from '../lib/supabaseClient'
import { firstRow, unwrap } from '../lib/errors'

export async function listMyGuilds() {
  const data = unwrap(await supabase.rpc('guild_my_guilds'), 'Could not load your guilds.')
  return (data || []).map((g) => ({
    id: g.group_id,
    name: g.name,
    description: g.description || '',
    visibility: g.visibility,
    inviteCode: g.invite_code,
    role: g.role,
    memberCount: Number(g.member_count || 0),
    joinedAt: g.joined_at,
  }))
}

export async function listPublicGuilds(search = '') {
  const data = unwrap(
    await supabase.rpc('guild_list_public', { p_search: search || null }),
    'Could not load the guild directory.',
  )
  return (data || []).map((g) => ({
    id: g.group_id,
    name: g.name,
    description: g.description || '',
    memberCount: Number(g.member_count || 0),
    maxMembers: Number(g.max_members || 50),
    isMember: Boolean(g.is_member),
  }))
}

export async function getGuildLeaderboard(groupId, timeframe = 'weekly') {
  const data = unwrap(
    await supabase.rpc('guild_leaderboard', { p_group_id: groupId, p_timeframe: timeframe }),
    'Could not load the leaderboard.',
  )
  return (data || []).map((r) => ({
    standing: Number(r.standing),
    displayName: r.display_name,
    role: r.role,
    xp: Number(r.xp || 0),
    totalXp: Number(r.total_xp || 0),
    joinedAt: r.joined_at,
    isSelf: Boolean(r.is_self),
  }))
}

export async function createGuild({ name, description, visibility }) {
  const row = firstRow(
    unwrap(
      await supabase.rpc('guild_create', {
        p_name: name,
        p_description: description || '',
        p_visibility: visibility || 'public',
      }),
      'Could not create the guild.',
    ),
  )
  return { id: row?.group_id, inviteCode: row?.invite_code }
}

export async function joinGuildByCode(code) {
  const row = firstRow(unwrap(await supabase.rpc('guild_join_by_code', { p_code: code }), 'Could not join that guild.'))
  return { id: row?.group_id, name: row?.name, joined: Boolean(row?.joined) }
}

export async function joinPublicGuild(groupId) {
  const row = firstRow(
    unwrap(await supabase.rpc('guild_join_public', { p_group_id: groupId }), 'Could not join that guild.'),
  )
  return { id: row?.group_id, name: row?.name, joined: Boolean(row?.joined) }
}

export async function leaveGuild(groupId) {
  unwrap(await supabase.rpc('guild_leave', { p_group_id: groupId }), 'Could not leave the guild.')
}
