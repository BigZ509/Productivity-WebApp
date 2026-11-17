import { useState } from 'react'
import { ArrowRight, Flame, Swords, Timer, TrendingUp } from 'lucide-react'
import { useAuth } from '../../app/providers/contexts'
import { hasSupabaseEnv, supabaseEnvError } from '../../lib/supabaseClient'
import { Notice, Spinner } from '../../components/ui'
import { cx } from '../../lib/cx'

const GOOGLE_ENABLED = import.meta.env.VITE_ENABLE_GOOGLE_AUTH === 'true'
const DEMO_BUILD = import.meta.env.VITE_DEMO_MODE === 'true'
const REMEMBER_KEY = 'zbxp.remember.email'

function readRemembered() {
  try {
    return window.localStorage.getItem(REMEMBER_KEY) || ''
  } catch {
    return ''
  }
}

const LOOP = [
  { icon: Swords, title: 'Choose a quest', text: 'Real work: ship, study, train, sell.' },
  { icon: Timer, title: 'Focus', text: 'A timer that survives tabs and reloads.' },
  { icon: TrendingUp, title: 'Level up', text: 'XP, ranks and a guild leaderboard.' },
]

export function AuthScreen() {
  const auth = useAuth()
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState(readRemembered)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [remember, setRemember] = useState(() => Boolean(readRemembered()))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  const switchMode = (next) => {
    setMode(next)
    setError('')
    setInfo('')
  }

  const onSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setInfo('')
    if (mode === 'signup' && password !== confirm) {
      setError('Passwords don’t match.')
      return
    }
    setBusy(true)
    try {
      if (mode === 'signin') {
        await auth.signInWithPassword(email, password)
        try {
          if (remember) window.localStorage.setItem(REMEMBER_KEY, email.trim())
          else window.localStorage.removeItem(REMEMBER_KEY)
        } catch {
          // ignore storage failures
        }
      } else {
        const { needsConfirmation } = await auth.signUp(email, password)
        if (needsConfirmation) {
          setInfo('Check your inbox to confirm your email, then sign in.')
          setMode('signin')
        }
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const onGoogle = async () => {
    setError('')
    setBusy(true)
    try {
      await auth.signInWithGoogle()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-hero" aria-labelledby="auth-hero-title">
        <div className="brand-mark brand-mark--lg">
          <span className="brand-mark__glyph" aria-hidden="true">Z</span>
          <span className="brand-mark__name">ZBXP</span>
        </div>
        <h1 id="auth-hero-title" className="auth-hero__title">
          Turn the work you need to do into progress you can see.
        </h1>
        <p className="auth-hero__lede">
          A life RPG for people who ship. Pick a path, accept real quests, focus, and watch your character climb.
        </p>
        <ol className="loop-list">
          {LOOP.map(({ icon: Icon, title, text }, i) => (
            <li key={title} className="loop-list__item">
              <span className="loop-list__step tabular">{String(i + 1).padStart(2, '0')}</span>
              <Icon size={18} aria-hidden="true" />
              <div>
                <strong>{title}</strong>
                <span>{text}</span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="auth-card" aria-labelledby="auth-card-title">
        <div className="segmented" role="tablist" aria-label="Account">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signin'}
            className={cx('segmented__btn', mode === 'signin' && 'is-active')}
            onClick={() => switchMode('signin')}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signup'}
            className={cx('segmented__btn', mode === 'signup' && 'is-active')}
            onClick={() => switchMode('signup')}
          >
            Create account
          </button>
        </div>

        <h2 id="auth-card-title" className="auth-card__title">
          {mode === 'signin' ? 'Welcome back' : 'Start your journey'}
        </h2>

        {auth.notice ? <Notice tone="info">{auth.notice}</Notice> : null}
        {DEMO_BUILD ? (
          <Notice tone="info" title="Demo build">
            Sign in with the demo account provided by your presenter.
          </Notice>
        ) : null}
        {!hasSupabaseEnv ? <Notice tone="error">{supabaseEnvError}</Notice> : null}

        <form className="form" onSubmit={onSubmit} noValidate={false}>
          <label className="field">
            <span className="field__label">Email</span>
            <input
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span className="field__label">Password</span>
            <input
              className="input"
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              minLength={mode === 'signup' ? 8 : 6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {mode === 'signup' ? <span className="field__hint">At least 8 characters.</span> : null}
          </label>
          {mode === 'signup' ? (
            <label className="field">
              <span className="field__label">Confirm password</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </label>
          ) : (
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>Remember my email on this device</span>
            </label>
          )}

          {error ? <Notice tone="error">{error}</Notice> : null}
          {info ? <Notice tone="success">{info}</Notice> : null}

          <button type="submit" className="btn btn--primary btn--block btn--lg" disabled={busy || !hasSupabaseEnv}>
            {busy ? <Spinner label="Working" /> : null}
            {mode === 'signin' ? 'Sign in' : 'Create account'}
            {!busy ? <ArrowRight size={18} aria-hidden="true" /> : null}
          </button>
        </form>

        {GOOGLE_ENABLED ? (
          <>
            <div className="divider">
              <span>or</span>
            </div>
            <button type="button" className="btn btn--ghost btn--block" onClick={onGoogle} disabled={busy}>
              Continue with Google
            </button>
          </>
        ) : null}

        <p className="auth-card__foot">
          <Flame size={14} aria-hidden="true" /> Your progress is saved to your account and synced across devices.
        </p>
      </section>
    </main>
  )
}
