import { supabase } from '../lib/supabaseClient'
import { addDays, dayKey } from '../lib/dates'
import { firstRow, unwrap } from '../lib/errors'

export async function loadTrainingData(userId, path) {
  const since = dayKey(addDays(new Date(), -35))
  const [plansRes, selectedRes, logsRes] = await Promise.all([
    supabase
      .from('workout_plans')
      .select('id, name, description, path')
      .eq('is_active', true)
      .eq('path', path)
      .order('created_at', { ascending: true }),
    supabase.from('user_selected_workout_plans').select('plan_id').eq('user_id', userId).maybeSingle(),
    supabase
      .from('workout_logs')
      .select('id, log_date, completed, payload')
      .eq('user_id', userId)
      .gte('log_date', since)
      .order('log_date', { ascending: true }),
  ])
  const plans = unwrap(plansRes, 'Could not load workout plans.') || []
  const selected = unwrap(selectedRes, 'Could not load your selected plan.')
  const logs = unwrap(logsRes, 'Could not load workout history.') || []
  const selectedPlanId = plans.some((p) => p.id === selected?.plan_id) ? selected.plan_id : plans[0]?.id || null
  return { plans, selectedPlanId, logs }
}

export async function loadPlanDays(planId) {
  if (!planId) return []
  const data = unwrap(
    await supabase
      .from('workout_plan_days')
      .select('id, day_number, title, template')
      .eq('plan_id', planId)
      .order('day_number', { ascending: true }),
    'Could not load plan days.',
  )
  return (data || []).map((d) => {
    const t = d.template || {}
    const items = Array.isArray(t.exercises) ? t.exercises : Array.isArray(t.work) ? t.work : []
    return {
      id: d.id,
      dayNumber: d.day_number,
      title: d.title,
      focus: t.focus || '',
      cardio: t.cardio || '',
      exercises: items.map((item) => (typeof item === 'string' ? item : item?.name || '')).filter(Boolean),
    }
  })
}

export async function selectWorkoutPlan(planId) {
  unwrap(await supabase.rpc('select_workout_plan', { p_plan_id: planId }), 'Could not select that plan.')
}

export async function recordWorkout({ date, completed, notes, bonusWalk, bonusRun, planDay, exercisesDone }) {
  const row = firstRow(
    unwrap(
      await supabase.rpc('record_workout', {
        p_date: date,
        p_completed: completed,
        p_payload: {
          notes: notes || '',
          bonus_walk_45: Boolean(bonusWalk),
          bonus_run_45: Boolean(bonusRun),
          plan_day: planDay || '',
          exercises_done: Number(exercisesDone || 0),
        },
      }),
      'Could not log the workout.',
    ),
  )
  return {
    xpAwarded: Number(row?.xp_awarded || 0),
    bonusXp: Number(row?.bonus_xp || 0),
    currentStreak: Number(row?.current_streak || 0),
    longestStreak: Number(row?.longest_streak || 0),
  }
}

// Pure helper: last N local days with log status.
export function buildDayGrid(logs, days = 28, now = new Date()) {
  const byDate = new Map(logs.map((l) => [l.log_date, l]))
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(now, -(days - 1 - i))
    const key = dayKey(date)
    const log = byDate.get(key)
    return { key, date, status: log ? (log.completed ? 'done' : 'missed') : 'none', notes: log?.payload?.notes || '' }
  })
}
