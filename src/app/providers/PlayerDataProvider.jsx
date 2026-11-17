import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { listActiveQuests } from '../../services/quests'
import { listXpEvents } from '../../services/activity'
import { listMyGuilds } from '../../services/guilds'
import { toAppError } from '../../lib/errors'
import { PlayerDataContext, ProfileContext } from './contexts'

// Shared, persisted player data used across screens (dashboard, quests,
// focus, character). Each slice reloads independently after mutations.
function useSlice(loader, enabled) {
  const [slice, setSlice] = useState({ status: 'idle', data: null, error: null })
  const reqRef = useRef(0)

  const reload = useCallback(async () => {
    if (!enabled) return null
    const id = ++reqRef.current
    setSlice((prev) => ({ ...prev, status: prev.data ? 'refreshing' : 'loading', error: null }))
    try {
      const data = await loader()
      if (id === reqRef.current) setSlice({ status: 'ready', data, error: null })
      return data
    } catch (error) {
      if (id === reqRef.current) setSlice((prev) => ({ ...prev, status: 'error', error: toAppError(error) }))
      return null
    }
  }, [loader, enabled])

  useEffect(() => {
    if (enabled) reload()
    else setSlice({ status: 'idle', data: null, error: null })
  }, [enabled, reload])

  return useMemo(() => ({ ...slice, reload }), [slice, reload])
}

export function PlayerDataProvider({ children }) {
  const { profile } = useContext(ProfileContext)
  const userId = profile?.id || null
  const enabled = Boolean(userId && profile?.path)

  const loadActive = useCallback(() => listActiveQuests(userId), [userId])
  const loadEvents = useCallback(() => listXpEvents(userId, { sinceDays: 60 }), [userId])
  const loadGuilds = useCallback(() => listMyGuilds(), [])

  const activeQuests = useSlice(loadActive, enabled)
  const xpEvents = useSlice(loadEvents, enabled)
  const guilds = useSlice(loadGuilds, enabled)

  const value = useMemo(
    () => ({
      activeQuests,
      xpEvents,
      guilds,
      reloadAfterReward: () => Promise.all([activeQuests.reload(), xpEvents.reload()]),
    }),
    [activeQuests, xpEvents, guilds],
  )

  return <PlayerDataContext.Provider value={value}>{children}</PlayerDataContext.Provider>
}
