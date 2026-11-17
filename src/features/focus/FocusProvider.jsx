import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FocusContext, usePlayerData, useProfile, useRewards } from '../../app/providers/contexts'
import { cancelFocusSession, completeFocusSession, startFocusSession } from '../../services/focus'
import { describeGain } from '../../lib/progression'
import { formatClock } from '../../lib/dates'
import * as engine from './focusEngine'

function readStorage(key) {
  try {
    return key ? window.localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function writeStorage(key, value) {
  try {
    if (key) window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable (private mode): the timer still works in-memory.
  }
}

function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.4)
    ;[660, 990].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.connect(gain)
      osc.start(ctx.currentTime + i * 0.18)
      osc.stop(ctx.currentTime + 1.4)
    })
    setTimeout(() => ctx.close(), 1800)
  } catch {
    // Audio is optional.
  }
}

export function FocusProvider({ children }) {
  const { profile, refresh } = useProfile()
  const { reloadAfterReward } = usePlayerData()
  const { showReward, toast } = useRewards()
  const storageKey = profile?.id ? `zbxp.focus.v1.${profile.id}` : null

  const [state, setState] = useState(() => engine.deserialize(readStorage(storageKey)))
  const [now, setNow] = useState(() => Date.now())
  const stateRef = useRef(state)
  const finishingRef = useRef(false)
  const xpRef = useRef(profile?.xp || 0)
  const finishRef = useRef(null)
  const path = profile?.path

  useLayoutEffect(() => {
    xpRef.current = profile?.xp || 0
  }, [profile?.xp])

  useLayoutEffect(() => {
    stateRef.current = state
  }, [state])

  const commit = useCallback(
    (updater) => {
      const next = typeof updater === 'function' ? updater(stateRef.current) : updater
      stateRef.current = next
      writeStorage(storageKey, engine.serialize(next))
      setState(next)
      return next
    },
    [storageKey],
  )

  // Reload persisted state when the signed-in user changes.
  const [loadedKey, setLoadedKey] = useState(storageKey)
  if (loadedKey !== storageKey) {
    setLoadedKey(storageKey)
    setState(engine.deserialize(readStorage(storageKey)))
  }

  // Keep other tabs in sync.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== storageKey) return
      const next = engine.deserialize(event.newValue)
      stateRef.current = next
      setState(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [storageKey])

  const finish = useCallback(async () => {
    if (finishingRef.current) return
    finishingRef.current = true
    const snapshot = stateRef.current
    commit(engine.markFinishing)
    playChime()

    let result
    if (snapshot.sessionId) {
      try {
        const before = xpRef.current
        const res = await completeFocusSession({
          sessionId: snapshot.sessionId,
          focusedSeconds: snapshot.plannedSeconds,
        })
        result = {
          recorded: true,
          xpAwarded: res.xpAwarded,
          focusedSeconds: res.focusedSeconds,
          message:
            res.xpAwarded > 0
              ? ''
              : snapshot.plannedSeconds < 300
                ? 'Recorded. Sessions under 5 minutes don’t earn XP.'
                : 'Recorded. You’ve reached today’s focus XP cap.',
        }
        const updated = await refresh()
        reloadAfterReward()
        if (res.xpAwarded > 0 && res.newlyCompleted) {
          showReward({
            xp: res.xpAwarded,
            title: 'Focus session complete',
            subtitle: snapshot.quest?.title ? `Linked to “${snapshot.quest.title}”` : `${Math.round(res.focusedSeconds / 60)} focused minutes`,
            gain: describeGain(before, updated?.xp ?? before + res.xpAwarded, path),
          })
        }
      } catch (error) {
        result = { recorded: false, xpAwarded: 0, focusedSeconds: snapshot.plannedSeconds, message: error.message }
        toast(error.message, 'error')
      }
    } else {
      result = {
        recorded: false,
        xpAwarded: 0,
        focusedSeconds: snapshot.plannedSeconds,
        message: 'This session ran offline, so it wasn’t recorded.',
      }
    }
    commit((s) => engine.markCompleted(s, result))
    finishingRef.current = false
  }, [commit, refresh, reloadAfterReward, showReward, toast, path])

  useLayoutEffect(() => {
    finishRef.current = finish
  }, [finish])

  // While running, a timer re-renders the countdown and detects completion.
  // Time is always computed from timestamps (the interval only triggers
  // renders), so throttled background tabs and reloads stay accurate. A
  // restored session that is already due completes on the first tick.
  useEffect(() => {
    if (state.status !== 'running') return undefined
    const tick = () => {
      const t = Date.now()
      setNow(t)
      if (engine.isDue(stateRef.current, t)) finishRef.current?.()
    }
    const first = setTimeout(tick, 0)
    const interval = setInterval(tick, 250)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearTimeout(first)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [state.status])

  const startSession = useCallback(
    async ({ minutes, quest }) => {
      const plannedSeconds = engine.clampMinutes(minutes) * 60
      const startedAt = Date.now()
      const previous = stateRef.current
      if (previous.sessionId && previous.status !== 'completed' && previous.status !== 'idle') {
        cancelFocusSession(previous.sessionId).catch(() => {})
      }
      commit(engine.start(previous, { plannedSeconds, quest, now: startedAt }))
      try {
        const res = await startFocusSession({ plannedSeconds, activeQuestId: quest?.activeQuestId })
        commit((s) => (s.startedAt === startedAt ? engine.attachServerSession(s, res) : s))
      } catch (error) {
        commit((s) => (s.startedAt === startedAt ? engine.markOffline(s) : s))
        toast(`${error.message} The timer will run, but this session won’t be recorded.`, 'error', { duration: 7000 })
      }
    },
    [commit, toast],
  )

  const pauseSession = useCallback(() => commit((s) => engine.pause(s, Date.now())), [commit])
  const resumeSession = useCallback(() => commit((s) => engine.resume(s, Date.now())), [commit])
  const resetSession = useCallback(() => {
    const current = stateRef.current
    if (current.sessionId && !['completed', 'idle'].includes(current.status)) {
      cancelFocusSession(current.sessionId).catch(() => {})
    }
    commit(engine.reset())
  }, [commit])

  const remaining = engine.remainingMs(state, now)

  // Show the countdown in the tab title while a session is active.
  useEffect(() => {
    const base = 'ZBXP'
    if (state.status === 'running' || state.status === 'paused') {
      document.title = `${formatClock(remaining / 1000)} ${state.status === 'paused' ? '(paused) ' : ''}· ${base}`
    } else {
      document.title = base
    }
  }, [state.status, remaining])

  const value = useMemo(
    () => ({
      state,
      remainingMs: remaining,
      elapsedMs: engine.elapsedMs(state, now),
      isActive: ['running', 'paused', 'finishing'].includes(state.status),
      startSession,
      pauseSession,
      resumeSession,
      resetSession,
    }),
    [state, remaining, now, startSession, pauseSession, resumeSession, resetSession],
  )

  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>
}
