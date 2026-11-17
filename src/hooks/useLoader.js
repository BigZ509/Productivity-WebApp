import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toAppError } from '../lib/errors'

// Page-local async data with loading/error/reload. Stale responses are
// ignored, so fast navigation or repeated reloads never apply old data.
export function useLoader(loader, deps, { enabled = true } = {}) {
  const [state, setState] = useState({ status: enabled ? 'loading' : 'idle', data: null, error: null })
  const reqRef = useRef(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps)

  const reload = useCallback(async () => {
    const id = ++reqRef.current
    setState((prev) => ({ ...prev, status: prev.data ? 'refreshing' : 'loading', error: null }))
    try {
      const data = await run()
      if (id === reqRef.current) setState({ status: 'ready', data, error: null })
      return data
    } catch (error) {
      if (id === reqRef.current) setState((prev) => ({ ...prev, status: 'error', error: toAppError(error) }))
      return null
    }
  }, [run])

  useEffect(() => {
    if (enabled) reload()
  }, [enabled, reload])

  return useMemo(() => ({ ...state, reload }), [state, reload])
}
