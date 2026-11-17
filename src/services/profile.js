import { supabase } from '../lib/supabaseClient'
import { firstRow, toAppError, unwrap } from '../lib/errors'
import { toXp } from '../lib/progression'

function normalizeProfile(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username || '',
    displayName: row.display_name || row.username || 'Hunter',
    path: row.path || null,
    xp: toXp(row.xp_total),
    currentStreak: Number(row.current_streak || 0),
    longestStreak: Number(row.longest_streak || 0),
    lastWorkoutDate: row.last_workout_date || null,
    createdAt: row.created_at || null,
  }
}

// Creates the profile row if missing (server-side) and returns it.
export async function ensureProfile() {
  const data = unwrap(await supabase.rpc('ensure_profile'), 'Could not load your profile.')
  const row = firstRow(data)
  if (!row) throw toAppError(null, 'Your profile could not be created.')
  return normalizeProfile(row)
}

export async function setIdentity({ displayName, path }) {
  unwrap(
    await supabase.rpc('set_identity', { p_display_name: displayName, p_path: path }),
    'Could not save your character.',
  )
}
