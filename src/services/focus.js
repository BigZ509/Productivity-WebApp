import { supabase } from '../lib/supabaseClient'
import { firstRow, unwrap } from '../lib/errors'

export async function startFocusSession({ plannedSeconds, activeQuestId }) {
  const row = firstRow(
    unwrap(
      await supabase.rpc('start_focus_session', {
        p_planned_seconds: plannedSeconds,
        p_active_quest_id: activeQuestId || null,
      }),
      'Could not start a focus session.',
    ),
  )
  return { sessionId: row?.session_id, startedAt: row?.started_at }
}

export async function completeFocusSession({ sessionId, focusedSeconds }) {
  const row = firstRow(
    unwrap(
      await supabase.rpc('complete_focus_session', {
        p_session_id: sessionId,
        p_focused_seconds: focusedSeconds,
      }),
      'Could not record the focus session.',
    ),
  )
  return {
    focusedSeconds: Number(row?.focused_seconds || 0),
    xpAwarded: Number(row?.xp_awarded || 0),
    newlyCompleted: Boolean(row?.newly_completed),
  }
}

export async function cancelFocusSession(sessionId) {
  if (!sessionId) return
  unwrap(await supabase.rpc('cancel_focus_session', { p_session_id: sessionId }), 'Could not cancel the session.')
}
