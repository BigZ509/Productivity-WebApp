import { useRegisterSW } from 'virtual:pwa-register/react'
import { RefreshCw } from 'lucide-react'

const CHECK_INTERVAL_MS = 60 * 60 * 1000

// Prompt-based service worker updates: a new deployment never silently swaps
// assets under a running session, and users are never stuck on a stale build.
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl, registration) {
      if (!registration) return
      setInterval(async () => {
        if (registration.installing || !navigator.onLine) return
        try {
          const resp = await fetch(swUrl, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } })
          if (resp.status === 200) await registration.update()
        } catch {
          // offline; try again next interval
        }
      }, CHECK_INTERVAL_MS)
    },
  })

  if (!needRefresh) return null
  return (
    <div className="update-banner" role="status">
      <RefreshCw size={16} aria-hidden="true" />
      <span>A new version of ZBXP is available.</span>
      <button type="button" className="btn btn--primary btn--sm" onClick={() => updateServiceWorker(true)}>
        Reload
      </button>
      <button type="button" className="btn btn--quiet btn--sm" onClick={() => setNeedRefresh(false)}>
        Later
      </button>
    </div>
  )
}
