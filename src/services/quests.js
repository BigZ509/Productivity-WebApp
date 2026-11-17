import { supabase } from '../lib/supabaseClient'
import { firstRow, unwrap } from '../lib/errors'

export const ACTIVE_QUEST_LIMIT = 5
export const QUEST_CATEGORIES = ['coding', 'study', 'business', 'gym']

function normalizeQuest(q) {
  if (!q) return null
  return {
    id: q.id,
    title: q.title,
    description: q.description || '',
    flavor: q.flavor_text || '',
    category: String(q.category || 'general').toLowerCase(),
    difficulty: String(q.difficulty || 'easy').toLowerCase(),
    xpReward: Number(q.xp_reward || 0),
    cooldownHours: Number(q.repeat_cooldown_hours ?? 20),
  }
}

export async function listAvailableQuests(path) {
  const data = unwrap(
    await supabase
      .from('quests')
      .select('id, title, description, flavor_text, category, difficulty, xp_reward, repeat_cooldown_hours')
      .eq('is_active', true)
      .eq('path', path)
      .order('xp_reward', { ascending: true }),
    'Could not load the quest board.',
  )
  return (data || []).map(normalizeQuest)
}

export async function listActiveQuests(userId) {
  const data = unwrap(
    await supabase
      .from('user_active_quests')
      .select('id, status, selected_at, quest:quests(id, title, description, flavor_text, category, difficulty, xp_reward, repeat_cooldown_hours)')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('selected_at', { ascending: true }),
    'Could not load your active quests.',
  )
  return (data || []).map((row) => ({
    id: row.id,
    status: row.status,
    selectedAt: row.selected_at,
    quest: normalizeQuest(row.quest),
  }))
}

export async function listQuestHistory(userId, { limit = 30 } = {}) {
  const data = unwrap(
    await supabase
      .from('user_active_quests')
      .select('id, quest_id, completed_at, quest:quests(id, title, category, difficulty, xp_reward), completion:quest_completions(note, xp_awarded)')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(limit),
    'Could not load your quest history.',
  )
  return (data || []).map((row) => {
    const completion = Array.isArray(row.completion) ? row.completion[0] : row.completion
    return {
      id: row.id,
      questId: row.quest_id,
      completedAt: row.completed_at,
      quest: normalizeQuest(row.quest),
      note: completion?.note || '',
      xpAwarded: Number(completion?.xp_awarded ?? row.quest?.xp_reward ?? 0),
    }
  })
}

export async function acceptQuest(questId) {
  const row = firstRow(
    unwrap(await supabase.rpc('accept_quest', { p_quest_id: questId }), 'Could not accept that quest.'),
  )
  return { activeQuestId: row?.active_quest_id, alreadyActive: Boolean(row?.already_active) }
}

export async function completeQuest(activeQuestId, { note, focusSessionId } = {}) {
  const row = firstRow(
    unwrap(
      await supabase.rpc('complete_active_quest', {
        p_active_quest_id: activeQuestId,
        p_note: note || null,
        p_focus_session_id: focusSessionId || null,
      }),
      'Could not complete that quest.',
    ),
  )
  return {
    xpAwarded: Number(row?.xp_awarded || 0),
    newlyCompleted: Boolean(row?.newly_completed),
    xpTotal: Number(row?.xp_total || 0),
    completedAt: row?.completed_at,
  }
}

export async function abandonQuest(activeQuestId) {
  unwrap(
    await supabase.rpc('abandon_active_quest', { p_active_quest_id: activeQuestId }),
    'Could not abandon that quest.',
  )
}
