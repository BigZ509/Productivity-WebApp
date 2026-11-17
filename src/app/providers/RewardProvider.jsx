import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUp, Crown, Info, TriangleAlert, X } from 'lucide-react'
import { RewardContext } from './contexts'

let nextId = 1

// Global feedback: XP reward cards (with level/rank-up) and plain toasts.
export function RewardProvider({ children }) {
  const [reward, setReward] = useState(null)
  const [toasts, setToasts] = useState([])
  const timers = useRef(new Map())

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.delete(id)
  }, [])

  const toast = useCallback(
    (message, tone = 'info', { duration = 4200 } = {}) => {
      const id = nextId++
      setToasts((prev) => [...prev.slice(-3), { id, message, tone }])
      timers.current.set(id, setTimeout(() => dismissToast(id), duration))
      return id
    },
    [dismissToast],
  )

  const showReward = useCallback((payload) => {
    setReward({ id: nextId++, ...payload })
  }, [])

  useEffect(() => {
    const map = timers.current
    return () => map.forEach((t) => clearTimeout(t))
  }, [])

  const value = useMemo(() => ({ toast, showReward }), [toast, showReward])

  return (
    <RewardContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`}>
            <span className="toast__icon" aria-hidden="true">
              {t.tone === 'success' ? <Check size={16} /> : t.tone === 'error' ? <TriangleAlert size={16} /> : <Info size={16} />}
            </span>
            <span className="toast__msg">{t.message}</span>
            <button type="button" className="icon-btn icon-btn--sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      {reward ? <RewardCard key={reward.id} reward={reward} onClose={() => setReward(null)} /> : null}
    </RewardContext.Provider>
  )
}

function useCountUp(target, durationMs = 900) {
  const reduce =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const [value, setValue] = useState(reduce ? target : 0)
  useEffect(() => {
    if (reduce) return undefined
    let frame
    const start = performance.now()
    const step = (t) => {
      const p = Math.min(1, (t - start) / durationMs)
      setValue(Math.round(target * (1 - Math.pow(1 - p, 3))))
      if (p < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target, durationMs, reduce])
  return value
}

function RewardCard({ reward, onClose }) {
  const { xp = 0, title, subtitle, gain } = reward
  const shown = useCountUp(xp)
  const closeRef = useRef(null)

  useEffect(() => {
    closeRef.current?.focus()
    const timer = setTimeout(onClose, gain?.leveledUp || gain?.rankedUp ? 6500 : 4200)
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose, gain])

  return (
    <div className="reward-layer" role="dialog" aria-modal="false" aria-labelledby="reward-title">
      <div className={`reward-card${gain?.rankedUp ? ' reward-card--rank' : gain?.leveledUp ? ' reward-card--level' : ''}`}>
        <div className="reward-card__burst" aria-hidden="true" />
        <p className="eyebrow">{xp > 0 ? 'Reward claimed' : 'Recorded'}</p>
        <p className="reward-card__xp tabular" aria-label={`${xp} XP gained`}>
          +{shown}
          <span>XP</span>
        </p>
        <h2 id="reward-title" className="reward-card__title">{title}</h2>
        {subtitle ? <p className="reward-card__sub">{subtitle}</p> : null}
        {gain?.rankedUp ? (
          <p className="reward-card__unlock">
            <Crown size={18} aria-hidden="true" /> Rank up: {gain.newRank.title}
          </p>
        ) : gain?.leveledUp ? (
          <p className="reward-card__unlock">
            <ChevronsUp size={18} aria-hidden="true" /> Level {gain.newLevel} reached
          </p>
        ) : null}
        <button ref={closeRef} type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
          Continue
        </button>
      </div>
    </div>
  )
}
