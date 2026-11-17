// Pure focus-timer state machine. Time is always derived from wall-clock
// timestamps (never from counting interval ticks), so background-tab
// throttling, navigation and reloads cannot drift the remaining time.
//
//   idle --start--> running <--pause/resume--> paused
//   running --(remaining hits 0)--> finishing --> completed
//   any --reset--> idle

export const FOCUS_PRESETS = [
  { id: 'sprint', label: 'Sprint', minutes: 25 },
  { id: 'deep', label: 'Deep work', minutes: 50 },
  { id: 'short', label: 'Short', minutes: 15 },
]

export const MIN_FOCUS_MINUTES = 1
export const MAX_FOCUS_MINUTES = 240
export const STORAGE_VERSION = 1

export const IDLE_STATE = Object.freeze({
  v: STORAGE_VERSION,
  status: 'idle',
  plannedSeconds: 25 * 60,
  accumulatedMs: 0,
  runningSince: null,
  startedAt: null,
  sessionId: null,
  syncState: 'none', // none | pending | synced | offline
  quest: null, // { activeQuestId, title }
  result: null, // { focusedSeconds, xpAwarded, recorded, message }
})

export function clampMinutes(minutes) {
  const n = Math.round(Number(minutes))
  if (!Number.isFinite(n)) return 25
  return Math.min(MAX_FOCUS_MINUTES, Math.max(MIN_FOCUS_MINUTES, n))
}

export function elapsedMs(state, now) {
  const base = Math.max(0, Number(state.accumulatedMs) || 0)
  if (state.status === 'running' && state.runningSince) {
    return base + Math.max(0, now - state.runningSince)
  }
  return base
}

export function remainingMs(state, now) {
  return Math.max(0, state.plannedSeconds * 1000 - elapsedMs(state, now))
}

export function isDue(state, now) {
  return state.status === 'running' && remainingMs(state, now) <= 0
}

export function start(state, { plannedSeconds, quest = null, now }) {
  return {
    ...IDLE_STATE,
    status: 'running',
    plannedSeconds,
    runningSince: now,
    startedAt: now,
    quest,
    syncState: 'pending',
  }
}

export function pause(state, now) {
  if (state.status !== 'running') return state
  return { ...state, status: 'paused', accumulatedMs: elapsedMs(state, now), runningSince: null }
}

export function resume(state, now) {
  if (state.status !== 'paused') return state
  return { ...state, status: 'running', runningSince: now }
}

export function markFinishing(state) {
  return { ...state, status: 'finishing', accumulatedMs: state.plannedSeconds * 1000, runningSince: null }
}

export function markCompleted(state, result) {
  return { ...state, status: 'completed', runningSince: null, result }
}

export function attachServerSession(state, { sessionId, startedAt }) {
  if (state.status === 'idle') return state
  return { ...state, sessionId, syncState: 'synced', serverStartedAt: startedAt || null }
}

export function markOffline(state) {
  if (state.status === 'idle') return state
  return { ...state, syncState: 'offline' }
}

export function reset() {
  return { ...IDLE_STATE }
}

// Persistence -----------------------------------------------------------

const VALID_STATUS = new Set(['idle', 'running', 'paused', 'finishing', 'completed'])

export function deserialize(raw) {
  if (!raw) return { ...IDLE_STATE }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed || parsed.v !== STORAGE_VERSION || !VALID_STATUS.has(parsed.status)) return { ...IDLE_STATE }
    const plannedSeconds = Number(parsed.plannedSeconds)
    if (!Number.isFinite(plannedSeconds) || plannedSeconds < 60 || plannedSeconds > MAX_FOCUS_MINUTES * 60) {
      return { ...IDLE_STATE }
    }
    // A reload mid-completion resumes as running-and-due so completion retries.
    const status = parsed.status === 'finishing' ? 'running' : parsed.status
    return {
      ...IDLE_STATE,
      ...parsed,
      status,
      runningSince: status === 'running' ? Number(parsed.runningSince) || Date.now() : null,
    }
  } catch {
    return { ...IDLE_STATE }
  }
}

export function serialize(state) {
  return JSON.stringify(state)
}
