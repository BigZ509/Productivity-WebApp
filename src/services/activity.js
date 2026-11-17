import { supabase } from '../lib/supabaseClient'
import { unwrap } from '../lib/errors'
import { addDays, dayKey, startOfLocalDay, startOfLocalWeek } from '../lib/dates'

// Reads the caller's own XP ledger (RLS: own rows only).
export async function listXpEvents(userId, { sinceDays = 60 } = {}) {
  const since = addDays(startOfLocalDay(), -sinceDays).toISOString()
  const data = unwrap(
    await supabase
      .from('xp_events')
      .select('id, source_type, source_id, amount, created_at')
      .eq('user_id', userId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1000),
    'Could not load your activity.',
  )
  return (data || []).map((e) => ({
    id: e.id,
    sourceType: e.source_type,
    sourceId: e.source_id,
    amount: Number(e.amount || 0),
    createdAt: e.created_at,
  }))
}

export async function countCompletionsByCategory(userId) {
  const data = unwrap(
    await supabase
      .from('user_active_quests')
      .select('quest:quests(category)')
      .eq('user_id', userId)
      .eq('status', 'completed'),
    'Could not load mastery data.',
  )
  const counts = {}
  for (const row of data || []) {
    const cat = String(row.quest?.category || 'general').toLowerCase()
    counts[cat] = (counts[cat] || 0) + 1
  }
  return counts
}

export async function listFocusSessions(userId, { limit = 50 } = {}) {
  const data = unwrap(
    await supabase
      .from('focus_sessions')
      .select('id, status, planned_seconds, focused_seconds, started_at, ended_at, xp_awarded, active_quest_id')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .order('started_at', { ascending: false })
      .limit(limit),
    'Could not load focus history.',
  )
  return data || []
}

// Pure aggregation helpers (unit tested) ------------------------------

// Events that represent real activity (excludes the one-time balance carry-over).
export function activityEvents(events) {
  return events.filter((e) => e.sourceType !== 'reconciliation')
}

export function summarizeWeek(events, now = new Date()) {
  const weekStart = startOfLocalWeek(now)
  const byDay = {}
  let xp = 0
  let quests = 0
  let workouts = 0
  let focus = 0
  for (const e of activityEvents(events)) {
    const at = new Date(e.createdAt)
    if (at < weekStart) continue
    const key = dayKey(at)
    byDay[key] = (byDay[key] || 0) + e.amount
    xp += e.amount
    if (e.sourceType === 'quest') quests += 1
    if (e.sourceType === 'workout') workouts += 1
    if (e.sourceType === 'focus') focus += 1
  }
  return { xp, quests, workouts, focusSessions: focus, byDay, activeDays: Object.keys(byDay).length }
}

// Activity streak: consecutive local days with at least one XP-earning
// activity, ending today (or yesterday, if nothing has been logged yet today).
export function activityStreak(events, now = new Date()) {
  const days = new Set(activityEvents(events).map((e) => dayKey(e.createdAt)))
  let cursor = startOfLocalDay(now)
  if (!days.has(dayKey(cursor))) cursor = addDays(cursor, -1)
  let streak = 0
  while (days.has(dayKey(cursor))) {
    streak += 1
    cursor = addDays(cursor, -1)
  }
  return { streak, activeToday: days.has(dayKey(now)) }
}

export async function countCompletedWorkouts(userId) {
  const res = await supabase
    .from('workout_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('completed', true)
  unwrap(res, 'Could not load workout totals.')
  return res.count ?? 0
}
