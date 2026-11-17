import { useCallback, useEffect, useState } from 'react'

// Per-user, per-device persistence for Lab notebooks (localStorage).
// Explicitly NOT synced to the server; the UI says so.
export function useDeviceStore(userId, name, initialValue) {
  const key = `zbxp.lab.v1.${userId}.${name}`
  const read = useCallback(() => {
    try {
      const raw = window.localStorage.getItem(key)
      return raw ? JSON.parse(raw) : initialValue
    } catch {
      return initialValue
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const [value, setValue] = useState(read)

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // storage unavailable: keep in memory
    }
  }, [key, value])

  return [value, setValue]
}
