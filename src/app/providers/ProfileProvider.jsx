import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ensureProfile } from '../../services/profile'
import { toAppError } from '../../lib/errors'
import { AuthContext, ProfileContext } from './contexts'

const LOAD_TIMEOUT_MS = 12000

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(toAppError({ message: 'Loading your profile timed out.' })), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

export function ProfileProvider({ children }) {
  const auth = useContext(AuthContext)
  const userId = auth?.user?.id || null
  const [state, setState] = useState({ status: userId ? 'loading' : 'idle', profile: null, error: null })
  const [trackedUserId, setTrackedUserId] = useState(userId)
  const requestRef = useRef(0)

  // Reset synchronously when the signed-in user changes (sign-out or switch),
  // so one user's profile is never rendered for another.
  if (trackedUserId !== userId) {
    setTrackedUserId(userId)
    setState({ status: userId ? 'loading' : 'idle', profile: null, error: null })
  }

  // Fetches and stores the profile. State is only set after the await, so
  // this is safe to call from an effect. `silent` keeps the last known
  // profile on screen if a background refresh fails.
  const fetchProfile = useCallback(
    async ({ silent = false } = {}) => {
      if (!userId) return null
      const requestId = ++requestRef.current
      try {
        const profile = await withTimeout(ensureProfile(), LOAD_TIMEOUT_MS)
        if (requestId !== requestRef.current) return profile
        setState({ status: 'ready', profile, error: null })
        return profile
      } catch (error) {
        if (requestId !== requestRef.current) return null
        const appError = toAppError(error)
        setState((prev) =>
          silent && prev.profile
            ? { ...prev, error: appError }
            : { status: 'error', profile: null, error: appError },
        )
        return null
      }
    },
    [userId],
  )

  const reload = useCallback(() => {
    setState((prev) => ({ ...prev, status: 'loading', error: null }))
    return fetchProfile()
  }, [fetchProfile])

  // Keyed on the user id only, so token refreshes don't refetch the profile.
  useEffect(() => {
    if (!userId) return undefined
    const requestId = ++requestRef.current
    withTimeout(ensureProfile(), LOAD_TIMEOUT_MS).then(
      (profile) => {
        if (requestId === requestRef.current) setState({ status: 'ready', profile, error: null })
      },
      (error) => {
        if (requestId === requestRef.current) setState({ status: 'error', profile: null, error: toAppError(error) })
      },
    )
    return () => {
      requestRef.current += 1
    }
  }, [userId])

  // Apply an authoritative XP total returned by an award RPC immediately.
  const applyServerXp = useCallback((xpTotal) => {
    const xp = Number(xpTotal)
    if (!Number.isFinite(xp)) return
    setState((prev) => (prev.profile ? { ...prev, profile: { ...prev.profile, xp } } : prev))
  }, [])

  const value = useMemo(
    () => ({
      ...state,
      reload,
      refresh: () => fetchProfile({ silent: true }),
      applyServerXp,
    }),
    [state, reload, fetchProfile, applyServerXp],
  )

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
}
