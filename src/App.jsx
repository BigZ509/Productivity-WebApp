import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { hasSupabaseEnv, supabase, supabaseEnvError } from './lib/supabaseClient'
import { usePerks } from './hooks/usePerks'
import { PATH_CONFIG, PATH_KEYS } from './config/pathConfig'

const AppContext = createContext(null)

function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppContext provider')
  return ctx
}

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

function formatDate(date) {
  return date.toISOString().slice(0, 10)
}

function todayIso() {
  return formatDate(new Date())
}

function levelFromXp(totalXP) {
  const xp = Number(totalXP || 0)
  return Math.max(1, Math.floor(xp / 100) + 1)
}

const RANK_TIERS = [
  { rank: 'E', min: 0, max: 499, colorClass: 'is-rank-e' },
  { rank: 'D', min: 500, max: 1499, colorClass: 'is-rank-d' },
  { rank: 'C', min: 1500, max: 4999, colorClass: 'is-rank-c' },
  { rank: 'B', min: 5000, max: 14999, colorClass: 'is-rank-b' },
  { rank: 'A', min: 15000, max: 49999, colorClass: 'is-rank-a' },
  { rank: 'S', min: 50000, max: Number.POSITIVE_INFINITY, colorClass: 'is-rank-s' },
]

function getRankInfo(totalXP) {
  const xp = Number(totalXP || 0)
  return RANK_TIERS.find((tier) => xp >= tier.min && xp <= tier.max) || RANK_TIERS[0]
}

function getProfileXp(profile) {
  return Number(profile?.total_xp ?? profile?.xp_total ?? 0)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hasEmailLikeValue(value) {
  return String(value || '').includes('@')
}

function safeDisplayName(rowLike, fallbackSeed = '') {
  const raw = String(
    rowLike?.display_name || rowLike?.username || rowLike?.name || rowLike?.handle || '',
  ).trim()
  if (raw && !hasEmailLikeValue(raw)) return raw
  const seed = String(rowLike?.user_id || rowLike?.id || fallbackSeed || '').replace(/-/g, '').slice(-4) || '0000'
  return `Hunter#${seed}`
}

async function incrementProfileXp(userId, deltaXp) {
  const delta = Number(deltaXp || 0)
  if (!userId || delta <= 0) {
    return { data: null, error: null }
  }

  let selectRes = await supabase
    .from('profiles')
    .select('id, total_xp, xp_total')
    .eq('id', userId)
    .single()

  if (selectRes.error && String(selectRes.error.message || '').toLowerCase().includes('total_xp')) {
    selectRes = await supabase
      .from('profiles')
      .select('id, xp_total')
      .eq('id', userId)
      .single()
  }
  if (selectRes.error) return { data: null, error: selectRes.error }

  const current = Number(selectRes.data?.total_xp ?? selectRes.data?.xp_total ?? 0)
  const next = current + delta

  let updateRes = await supabase
    .from('profiles')
    .update({ total_xp: next })
    .eq('id', userId)
    .select('id, total_xp, xp_total')
    .single()

  if (updateRes.error && String(updateRes.error.message || '').toLowerCase().includes('total_xp')) {
    updateRes = await supabase
      .from('profiles')
      .update({ xp_total: next })
      .eq('id', userId)
      .select('id, total_xp, xp_total')
      .single()
  }

  return { data: updateRes.data || null, error: updateRes.error || null }
}

async function hydrateRowsWithProfileNames(rows) {
  const list = Array.isArray(rows) ? rows : []
  const ids = [...new Set(list.map((row) => row?.user_id).filter(Boolean))]
  if (ids.length === 0) return list

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name')
    .in('id', ids)

  if (error || !data) return list
  const byId = new Map(data.map((row) => [row.id, row]))
  return list.map((row) => {
    const profileRow = byId.get(row.user_id)
    const resolvedName =
      profileRow?.display_name ||
      profileRow?.username ||
      row?.display_name ||
      row?.username
    return {
      ...row,
      username: resolvedName || row?.username || null,
      display_name: profileRow?.display_name || row?.display_name || null,
    }
  })
}

function isInvalidCredentialError(error) {
  const message = String(error?.message || '').toLowerCase()
  return message.includes('invalid login credentials') || message.includes('invalid credentials')
}

function isEmailConfirmationError(error) {
  const message = String(error?.message || '').toLowerCase()
  return message.includes('email not confirmed') || message.includes('email confirmation')
}

function isRateLimitError(error) {
  const message = String(error?.message || '').toLowerCase()
  return message.includes('rate limit') || message.includes('too many requests')
}

function isAuthLockTimeoutError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return (
    (message.includes('lockmanager') || message.includes('lock:sb-') || message.includes('auth-token')) &&
    message.includes('timed out')
  )
}

function hasAuthCallbackParams() {
  if (typeof window === 'undefined') return false
  const url = new URL(window.location.href)
  if (url.pathname === '/auth/callback') return true
  const hash = new URLSearchParams((url.hash || '').replace(/^#/, ''))
  const hasHashAuth =
    hash.has('access_token') ||
    hash.has('refresh_token') ||
    hash.has('error') ||
    hash.has('error_description') ||
    hash.get('type') === 'signup'
  const hasQueryAuth = url.searchParams.has('code') || url.searchParams.has('error_description')
  return hasHashAuth || hasQueryAuth
}

async function tryAcquireBootLock() {
  if (typeof navigator === 'undefined' || !navigator?.locks?.request) {
    return { acquired: true, reason: 'unsupported' }
  }
  let acquired = false
  try {
    await navigator.locks.request(
      'lock:zbxp-auth-bootstrap',
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        acquired = Boolean(lock)
        return acquired
      },
    )
    return { acquired, reason: acquired ? 'acquired' : 'busy' }
  } catch (error) {
    console.warn('[bootstrap.lock] non-fatal lock check failed', String(error?.message || error))
    return { acquired: true, reason: 'error' }
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId)
  })
}

async function ensureProfile(user) {
  const safeUsername = `Hunter#${String(user.id || '').replace(/-/g, '').slice(-4) || '0000'}`

  const seedPayload = {
    id: user.id,
    username: safeUsername,
    player_class: 'HUNTER',
    path: 'HUNTER',
    total_xp: 0,
    xp_total: 0,
    current_streak: 0,
    longest_streak: 0,
  }

  let insertRes = await supabase
    .from('profiles')
    .upsert(seedPayload, { onConflict: 'id', ignoreDuplicates: true })

  if (insertRes.error) {
    console.warn('[bootstrap.profile] seed upsert failed', {
      code: insertRes.error.code,
      message: insertRes.error.message,
      details: insertRes.error.details,
      hint: insertRes.error.hint,
    })
    const msg = String(insertRes.error.message || '').toLowerCase()
    const missingOptionalColumn =
      msg.includes('column') &&
      (msg.includes('path') || msg.includes('total_xp') || msg.includes('xp_total') || msg.includes('current_streak') || msg.includes('longest_streak'))
    if (missingOptionalColumn) {
      insertRes = await supabase
        .from('profiles')
        .upsert(
          {
            id: user.id,
            username: safeUsername,
            player_class: 'HUNTER',
          },
          { onConflict: 'id', ignoreDuplicates: true },
        )
    }
  }

  if (insertRes.error) throw insertRes.error

  const selectCandidates = [
    'id, username, path, player_class, total_xp, current_streak, longest_streak',
    'id, username, path, player_class, xp_total, current_streak, longest_streak',
    'id, username, player_class, total_xp, current_streak, longest_streak',
    'id, username, player_class, xp_total, current_streak, longest_streak',
    'id, username, player_class',
  ]

  let lastError = null
  for (const fields of selectCandidates) {
    const profileResponse = await supabase
      .from('profiles')
      .select(fields)
      .eq('id', user.id)
      .single()

    if (!profileResponse.error) {
      return profileResponse.data
    }
    console.warn('[bootstrap.profile] select candidate failed', {
      fields,
      status: profileResponse.status,
      code: profileResponse.error.code,
      message: profileResponse.error.message,
    })
    lastError = profileResponse.error
  }

  throw lastError || new Error('Profile query failed')
}

function PathSelectScreen({ profile, onSaved }) {
  const [username, setUsername] = useState(profile?.username || '')
  const [pathKey, setPathKey] = useState(profile?.path || '')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    setError('')

    if (!username.trim()) {
      setError('Username is required.')
      return
    }

    if (!PATH_CONFIG[pathKey]) {
      setError('Choose a path first.')
      return
    }

    setIsSaving(true)
    let updateRes = await supabase
      .from('profiles')
      .update({ username: username.trim(), display_name: username.trim(), path: pathKey })
      .eq('id', profile.id)

    if (updateRes.error) {
      const msg = String(updateRes.error.message || '').toLowerCase()
      const missingDisplayName = msg.includes('display_name') && msg.includes('does not exist')
      if (missingDisplayName) {
        updateRes = await supabase
          .from('profiles')
          .update({ username: username.trim(), path: pathKey })
          .eq('id', profile.id)
      }
    }

    setIsSaving(false)

    if (updateRes.error) {
      setError(updateRes.error.message)
      return
    }

    onSaved()
  }

  return (
    <main className="auth-shell">
      <form className="panel form-grid path-select-panel" onSubmit={submit}>
        <h2>Choose Your Path</h2>
        <p className="muted">This sets your mirrored progression experience and questline flavor.</p>

        <label>
          Username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            maxLength={40}
            placeholder="How your profile appears"
            required
          />
        </label>

        <div className="path-options">
          {PATH_KEYS.map((key) => {
            const config = PATH_CONFIG[key]
            return (
              <button
                key={key}
                type="button"
                className={cx('path-option', pathKey === key && 'is-selected')}
                onClick={() => setPathKey(key)}
              >
                <strong>{config.title}</strong>
                <span className="muted">{config.subtitle}</span>
              </button>
            )
          })}
        </div>

        <button type="submit" disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Enter World'}
        </button>

        {error ? <p className="error-text">{error}</p> : null}
      </form>
    </main>
  )
}

function AuthScreen() {
  const REMEMBER_EMAIL_KEY = 'zbxp.remember.email'
  const rememberedEmail = typeof window !== 'undefined' ? window.localStorage.getItem(REMEMBER_EMAIL_KEY) || '' : ''
  const [mode, setMode] = useState('signin')
  const [selectedRank, setSelectedRank] = useState('E')
  const [email, setEmail] = useState(rememberedEmail)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [hunterName, setHunterName] = useState('')
  const [rememberMe, setRememberMe] = useState(Boolean(rememberedEmail))
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [pointer, setPointer] = useState({ x: 0, y: 0 })
  const DEV_EMAIL = 'test@test.com'
  const DEV_PASSWORD = '123456'
  const DEV_SIGNUP_COOLDOWN_MS = 10 * 60 * 1000

  const runDevLoginFlow = async () => {
    setFeedback('Attempting Dev Login...')

    const loginAttempt = await supabase.auth.signInWithPassword({
      email: DEV_EMAIL,
      password: DEV_PASSWORD,
    })

    if (!loginAttempt.error) {
      return { ok: true, message: 'Signed in with QA dev account.' }
    }

    if (!isInvalidCredentialError(loginAttempt.error)) {
      return { ok: false, message: loginAttempt.error.message }
    }

    const cooldownKey = 'zbxp.devSignupCooldownUntil'
    const cooldownUntil = Number(window.localStorage.getItem(cooldownKey) || 0)
    if (Date.now() < cooldownUntil) {
      const minsLeft = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 60000))
      return {
        ok: false,
        message: `Dev signup cooldown active (${minsLeft}m left) due to email rate limits. Try Dev Login again later, or sign in once the account exists.`,
      }
    }

    setFeedback('Dev account not found. Creating account...')
    const signUpAttempt = await supabase.auth.signUp({
      email: DEV_EMAIL,
      password: DEV_PASSWORD,
    })

    if (isRateLimitError(signUpAttempt.error)) {
      window.localStorage.setItem(cooldownKey, String(Date.now() + DEV_SIGNUP_COOLDOWN_MS))
      return {
        ok: false,
        message:
          'Email rate limit exceeded while creating dev account. Wait a few minutes, then click Dev Login once. If account already exists, use Sign in directly.',
      }
    }

    if (signUpAttempt.error && !String(signUpAttempt.error.message || '').toLowerCase().includes('already')) {
      return { ok: false, message: signUpAttempt.error.message }
    }

    setFeedback('Account created. Attempting sign in...')
    const secondLoginAttempt = await supabase.auth.signInWithPassword({
      email: DEV_EMAIL,
      password: DEV_PASSWORD,
    })

    if (secondLoginAttempt.error) {
      if (isEmailConfirmationError(secondLoginAttempt.error) || (signUpAttempt.data?.user && !signUpAttempt.data?.session)) {
        return {
          ok: false,
          message:
            'Dev account created. Email confirmation is enabled in Supabase. Disable confirm email for dev or confirm the user.',
        }
      }
      return { ok: false, message: secondLoginAttempt.error.message }
    }

    return { ok: true, message: 'Signed in with QA dev account.' }
  }

  const onSubmit = async (event) => {
    event.preventDefault()
    setFeedback('')
    if (!supabase) {
      setFeedback(supabaseEnvError)
      return
    }

    if (mode === 'signup' && password !== confirmPassword) {
      setFeedback('Confirm access code does not match.')
      return
    }

    setIsSubmitting(true)

    const response =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })

    setIsSubmitting(false)

    if (response.error) {
      if (isEmailConfirmationError(response.error)) {
        setFeedback(
          'Email confirmation is enabled in Supabase. Confirm your email first, or disable confirm email for local dev.',
        )
        return
      }
      setFeedback(response.error.message)
      return
    }

    if (mode === 'signup' && !response.data.session) {
      setFeedback('Signup created. Confirm email, then sign in.')
      return
    }

    if (mode === 'signin') {
      if (rememberMe) {
        window.localStorage.setItem(REMEMBER_EMAIL_KEY, email.trim())
      } else {
        window.localStorage.removeItem(REMEMBER_EMAIL_KEY)
      }
    }

    setFeedback('Authenticated. Loading profile...')
  }

  const onGoogleSignIn = async () => {
    setFeedback('')
    if (!supabase) {
      setFeedback(supabaseEnvError)
      return
    }

    setIsSubmitting(true)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    setIsSubmitting(false)

    if (error) {
      setFeedback(error.message || 'Google sign in failed.')
      return
    }

    setFeedback('Redirecting to Google...')
  }

  const signInDevAccount = async () => {
    if (!supabase) {
      setFeedback(supabaseEnvError)
      return
    }
    setFeedback('')
    setIsSubmitting(true)
    const devResult = await runDevLoginFlow()
    setIsSubmitting(false)
    setFeedback(devResult.message)
  }

  const onMouseMove = (event) => {
    const x = event.clientX / window.innerWidth - 0.5
    const y = event.clientY / window.innerHeight - 0.5
    setPointer({ x, y })
  }

  return (
    <main className="auth-shell auth-cinematic auth-v4-shell" onMouseMove={onMouseMove}>
      <div className="auth-bg-stage" aria-hidden="true">
        <div className="auth-bg-overlay" />
        <div
          className="auth-bg-glow"
          style={{
            transform: `translate3d(${pointer.x * 18}px, ${pointer.y * 12}px, 0)`,
          }}
        />
      </div>

      <div className="auth-v4-wrap">
        <div className="auth-v4-logo">
          <div className="auth-v4-logo-gate">// HUNTER AUTHENTICATION PORTAL</div>
          <div className="auth-v4-logo-title">ZBXP</div>
          <div className="auth-v4-logo-sub">SOLO LEVELING PRODUCTIVITY SYSTEM - <span>CLOSED BETA</span></div>
        </div>

        <div className="auth-v4-rank-selector">
          {['E', 'D', 'C', 'B', 'A', 'S'].map((rank) => (
            <button
              key={rank}
              type="button"
              className={cx('auth-v4-rank-pill', selectedRank === rank && 'active')}
              onClick={() => setSelectedRank(rank)}
            >
              <div className="auth-v4-rank-letter">{rank}</div>
              <div className="auth-v4-rank-label">
                {rank === 'E' ? 'ENTRY' : rank === 'D' ? 'NOVICE' : rank === 'C' ? 'SKILLED' : rank === 'B' ? 'ELITE' : rank === 'A' ? 'VETERAN' : 'LEGEND'}
              </div>
            </button>
          ))}
        </div>

        <div className="auth-v4-card">
          <div className={cx('auth-v4-flash', feedback && 'visible')}>
            {feedback || 'ACCESS PORTAL READY'}
          </div>

          <form className="auth-v4-inner" onSubmit={onSubmit}>
            <div className="auth-v4-header">
              <div className="auth-v4-title">{mode === 'signin' ? 'HUNTER LOGIN' : 'CREATE HUNTER'}</div>
              <div className="auth-v4-mode-toggle">
                <button type="button" className={cx('auth-v4-mode-btn', mode === 'signin' && 'active')} onClick={() => { setMode('signin'); setFeedback('') }}>
                  LOGIN
                </button>
                <button type="button" className={cx('auth-v4-mode-btn', mode === 'signup' && 'active')} onClick={() => { setMode('signup'); setFeedback('') }}>
                  REGISTER
                </button>
              </div>
            </div>

            <label className="auth-v4-label">HUNTER ID (EMAIL)</label>
            <div className="auth-v4-input-wrap">
              <input
                className="auth-v4-input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                placeholder="hunter@zbxp.gg"
                required
              />
              <span className="auth-v4-input-icon">👤</span>
            </div>

            <label className="auth-v4-label">ACCESS CODE</label>
            <div className="auth-v4-input-wrap">
              <input
                className="auth-v4-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                placeholder="••••••••••••"
                minLength={6}
                required
              />
              <span className="auth-v4-input-icon">🔒</span>
            </div>

            {mode === 'signup' ? (
              <>
                <label className="auth-v4-label">CONFIRM ACCESS CODE</label>
                <div className="auth-v4-input-wrap">
                  <input
                    className="auth-v4-input"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="••••••••••••"
                    minLength={6}
                    required
                  />
                  <span className="auth-v4-input-icon">🔐</span>
                </div>

                <label className="auth-v4-label">HUNTER NAME</label>
                <div className="auth-v4-input-wrap">
                  <input
                    className="auth-v4-input"
                    type="text"
                    value={hunterName}
                    onChange={(event) => setHunterName(event.target.value)}
                    placeholder="e.g. ShadowKing"
                    maxLength={20}
                  />
                  <span className="auth-v4-input-icon">⚔️</span>
                </div>
              </>
            ) : (
              <label className="auth-remember-row auth-v4-remember">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(event) => setRememberMe(event.target.checked)}
                />
                <span>Remember login email</span>
              </label>
            )}

            <button className="auth-v4-submit" type="submit" disabled={isSubmitting || !hasSupabaseEnv}>
              {isSubmitting ? 'PLEASE WAIT...' : mode === 'signin' ? 'ENTER THE GATE' : 'FORGE IDENTITY'}
            </button>

            <div className="auth-divider">
              <span />
              <p>OR AUTHENTICATE WITH</p>
              <span />
            </div>

            <div className="auth-social-row">
              <button type="button" className="auth-social-btn" onClick={onGoogleSignIn} disabled={isSubmitting || !hasSupabaseEnv}>
                <span aria-hidden="true">🌐</span>
                GOOGLE
              </button>
            </div>

            <div className="auth-v4-footer-actions">
              {import.meta.env.DEV ? (
                <button type="button" className="text-button dev-login-btn" onClick={signInDevAccount} disabled={isSubmitting || !hasSupabaseEnv}>
                  {isSubmitting ? 'Processing...' : 'Dev Login'}
                </button>
              ) : null}

              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setMode((prev) => (prev === 'signin' ? 'signup' : 'signin'))
                  setFeedback('')
                }}
              >
                {mode === 'signin' ? 'Need an account? Create one' : 'Already have an account? Sign in'}
              </button>
            </div>

            {!hasSupabaseEnv ? <p className="error-text">{supabaseEnvError}</p> : null}
          </form>
        </div>
      </div>
    </main>
  )
}

function AuthCallbackPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState('Verifying your link...')
  const [error, setError] = useState('')
  const [hasSession, setHasSession] = useState(false)

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      if (!supabase) {
        if (!cancelled) {
          setError(supabaseEnvError || 'Auth client unavailable')
          setStatus('Verification unavailable')
        }
        return
      }

      try {
        const url = new URL(window.location.href)
        const hashParams = new URLSearchParams((url.hash || '').replace(/^#/, ''))
        const hashError = hashParams.get('error_description') || hashParams.get('error')
        if (hashError) {
          throw new Error(hashError)
        }
        const code = url.searchParams.get('code')
        if (code) {
          const exchange = await supabase.auth.exchangeCodeForSession(code)
          if (exchange.error) {
            throw exchange.error
          }
        }

        const sessionRes = await supabase.auth.getSession()
        if (sessionRes.error) throw sessionRes.error

        if (!cancelled) {
          const ok = Boolean(sessionRes.data.session)
          const tokenInHash = hashParams.has('access_token')
          setHasSession(ok)
          setStatus(
            ok || tokenInHash
              ? 'Email verified. You are ready.'
              : 'Verification complete. Please login to continue.',
          )
        }
      } catch (err) {
        if (!cancelled) {
          setError(err?.message || 'Verification failed')
          setStatus('Verification failed')
        }
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="auth-shell">
      <section className="panel auth-panel form-stack">
        <h2>Auth Callback</h2>
        <p className="muted">{status}</p>
        {error ? <p className="error-text">{error}</p> : null}
        {hasSession ? (
          <button type="button" className="btn btn-cyan" onClick={() => navigate('/dashboard')}>
            Continue to Dashboard
          </button>
        ) : (
          <button type="button" className="btn btn-cyan" onClick={() => navigate('/')}>
            Login
          </button>
        )}
        <button type="button" className="text-button" onClick={() => navigate('/')}>
          Back to Login
        </button>
      </section>
    </main>
  )
}

function HudPanel({ title, subtitle, children }) {
  return (
    <article className="panel">
      {title ? <h3 className="panel-title">{title}</h3> : null}
      {subtitle ? <p className="panel-sub">{subtitle}</p> : null}
      {children}
    </article>
  )
}

function RankBadge({ rankInfo }) {
  const rankColor = {
    'is-rank-e': 'var(--e-rank)',
    'is-rank-d': 'var(--d-rank)',
    'is-rank-c': 'var(--c-rank)',
    'is-rank-b': 'var(--b-rank)',
    'is-rank-a': 'var(--a-rank)',
    'is-rank-s': 'var(--s-rank)',
  }[rankInfo.colorClass] || 'var(--e-rank)'

  return (
    <span className="rank-letter" style={{ color: rankColor }}>{rankInfo.rank}</span>
  )
}

function ProfileHUD({ profile, weeklyXP, statPulse }) {
  const { pathConfig } = useApp()
  const totalXP = getProfileXp(profile)
  const level = levelFromXp(totalXP)
  const progress = totalXP % 100
  const rankInfo = getRankInfo(totalXP)
  const nextLevelXp = Math.ceil((totalXP + 1) / 100) * 100
  const streakDays = Math.max(0, Number(profile?.current_streak || 0))
  const streakActiveCount = Math.min(7, streakDays)

  return (
    <section className="hunter-card">
      <div className="corner corner-tl" />
      <div className="corner corner-tr" />
      <div className="corner corner-bl" />
      <div className="corner corner-br" />

      <div className="hunter-top">
        <div className="hunter-identity">
          <div className="hunter-name">{pathConfig.title}</div>
          <div className="hunter-username">@{profile?.username || 'unnamed'}</div>
          <div className="hunter-title">{pathConfig.worldLabel}</div>
        </div>
        <div className="rank-badge">
          <RankBadge rankInfo={rankInfo} />
          <div className="rank-label">RANK</div>
        </div>
      </div>

      <div className="xp-section">
        <div className="xp-meta">
          <span className="xp-current">{totalXP} XP</span>
          <span className="xp-target">{nextLevelXp} XP → LVL {level + 1}</span>
        </div>
        <div className="xp-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <span className="xp-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="xp-footer">
          <span className={cx('xp-stat', statPulse > 0 && 'is-pulsing')}>
            WEEKLY: <span>{weeklyXP}</span>
          </span>
          <span className="xp-stat">
            LEVEL: <span>{level}</span>
          </span>
          <span className="xp-stat">
            TOTAL: <span>{totalXP}</span> {statPulse > 0 ? <span className="gain-chip">+{statPulse}</span> : null}
          </span>
        </div>
      </div>

      <div className="streak-row">
        <span className="streak-label">7-DAY</span>
        <div className="streak-dots">
          {Array.from({ length: 7 }).map((_, idx) => {
            const className =
              idx < streakActiveCount
                ? idx === streakActiveCount - 1
                  ? 's-dot today'
                  : 's-dot done'
                : 's-dot'
            return <span key={idx} className={className} />
          })}
        </div>
        <span className="streak-count">🔥 {streakDays} DAYS</span>
      </div>
    </section>
  )
}

function DashboardPage({ onProfileRefresh, onXpGain }) {
  const { pathConfig, profile } = useApp()
  const claimKey = `zbxp.daily.claim.${profile?.id || 'anon'}.${todayIso()}`
  const [dailyClaimed, setDailyClaimed] = useState(() => {
    try {
      return typeof window !== 'undefined' && window.localStorage.getItem(claimKey) === '1'
    } catch {
      return false
    }
  })
  const [dailyClaiming, setDailyClaiming] = useState(false)
  const [dailyError, setDailyError] = useState('')
  const totalXP = getProfileXp(profile)
  const level = levelFromXp(totalXP)
  const rank = getRankInfo(totalXP).rank
  const scrollToSection = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const onClaimDailyXp = async () => {
    if (dailyClaimed || dailyClaiming) return
    setDailyError('')
    setDailyClaiming(true)

    const nextTotal = totalXP + 10
    let updateRes = await supabase
      .from('profiles')
      .update({ total_xp: nextTotal })
      .eq('id', profile.id)
      .select('id, total_xp, xp_total')
      .single()

    if (updateRes.error && String(updateRes.error.message || '').toLowerCase().includes('total_xp')) {
      updateRes = await supabase
        .from('profiles')
        .update({ xp_total: nextTotal })
        .eq('id', profile.id)
        .select('id, total_xp, xp_total')
        .single()
    }

    if (updateRes.error) {
      setDailyError(`Daily claim failed: ${updateRes.error.message}`)
      setDailyClaiming(false)
      return
    }

    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(claimKey, '1')
      }
    } catch {
      // ignore localStorage write issues
    }

    setDailyClaimed(true)
    onXpGain(10)
    await onProfileRefresh()
    setDailyClaiming(false)
  }

  return (
    <section className="tab-content active guild-s1-wrap">
      <div className="actions section-jump-actions">
        <button type="button" className="btn btn-cyan" onClick={() => scrollToSection('weekly-challenge')}>
          Weekly Challenge
        </button>
        <button type="button" className="btn btn-cyan" onClick={() => scrollToSection('active-missions')}>
          Active Missions
        </button>
        <button type="button" className="btn btn-cyan" onClick={() => scrollToSection('unlock-grid')}>
          Unlock Grid
        </button>
        <button type="button" className="btn btn-cyan" onClick={() => scrollToSection('share-card')}>
          Share Card
        </button>
      </div>

      <div className="daily-login-card">
        <div>
          <div className="daily-tag">✦ DAILY LOGIN BONUS</div>
          <div className="daily-title">Day 4 Reward Available</div>
          <div className="daily-sub">
            Streak bonus: <span>+10 XP</span> - claim before midnight
          </div>
        </div>
        <button type="button" className="btn btn-green" disabled={dailyClaimed || dailyClaiming} onClick={onClaimDailyXp}>
          {dailyClaimed ? 'CLAIMED' : dailyClaiming ? 'CLAIMING...' : 'CLAIM +10 XP'}
        </button>
      </div>
      {dailyError ? <p className="error-text">{dailyError}</p> : null}

      <div className="system-alert">
        <div className="system-alert-text">
          A new gate has opened. <span className="warn">Weekly boss spawns in 2 days.</span>
          {' '}Complete <span className="hi">3 missions today</span> to maintain your rank standing.
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-box">
          <span className="stat-label">LEVEL</span>
          <div className="stat-val">{level}</div>
        </div>
        <div className="stat-box">
          <span className="stat-label">TOTAL XP</span>
          <div className="stat-val">{totalXP}</div>
        </div>
        <div className="stat-box">
          <span className="stat-label">STREAK</span>
          <div className="stat-val" style={{ color: 'var(--gold)' }}>{Number(profile?.current_streak || 0)}</div>
        </div>
        <div className="stat-box">
          <span className="stat-label">RANK</span>
          <div className="stat-val" style={{ color: 'var(--e-rank)', fontSize: '26px' }}>{rank}</div>
        </div>
      </div>

      <div id="weekly-challenge" className="challenge-card">
        <div className="challenge-title">Complete 10 quests this week</div>
        <div className="ch-track"><div className="ch-fill" style={{ width: '40%' }} /></div>
        <div className="ch-foot">
          <span>Progress: <span>4 / 10</span></span>
          <span>Reward: <span>+150 XP + TITLE</span></span>
        </div>
      </div>

      <div id="active-missions" className="panel">
        <div className="panel-title">Active Missions</div>
        <div className="panel-sub">// your current active quests - live from quest system</div>
        <div className="quest-list">
          <article className="quest-item q-study">
            <div className="quest-icon">📖</div>
            <div className="quest-info">
              <div className="quest-name">Study Progress Mission</div>
              <div className="quest-desc">// review and complete from your live quest list</div>
            </div>
            <div className="quest-xp">LIVE</div>
            <NavLink to="/quests" className="quest-complete-btn">Open</NavLink>
          </article>
          <article className="quest-item q-coding">
            <div className="quest-icon">💻</div>
            <div className="quest-info">
              <div className="quest-name">Coding Progress Mission</div>
              <div className="quest-desc">// select and clear coding quests to gain XP</div>
            </div>
            <div className="quest-xp">LIVE</div>
            <NavLink to="/quests" className="quest-complete-btn">Open</NavLink>
          </article>
          <article className="quest-item q-gym">
            <div className="quest-icon">⚔️</div>
            <div className="quest-info">
              <div className="quest-name">Training Mission</div>
              <div className="quest-desc">// log workouts and keep your streak active</div>
            </div>
            <div className="quest-xp">LIVE</div>
            <NavLink to="/gym" className="quest-complete-btn">Open</NavLink>
          </article>
        </div>
      </div>

      <div id="unlock-grid" className="panel">
        <div className="panel-title">Hunter Unlocks</div>
        <div className="panel-sub">// rank up to reveal titles, avatars, and abilities</div>
        <div className="unlock-grid">
          <div className="unlock-item unlocked" style={{ border: '1px solid rgba(245,158,11,0.5)', boxShadow: '0 0 14px rgba(245,158,11,0.15)' }}><div className="unlock-emoji">🗡️</div><div className="unlock-level">LVL 1</div></div>
          <div className="unlock-item unlocked" style={{ border: '1px solid rgba(245,158,11,0.5)', boxShadow: '0 0 14px rgba(245,158,11,0.15)' }}><div className="unlock-emoji">🛡️</div><div className="unlock-level">LVL 1</div></div>
          <div className="unlock-item locked" style={{ filter: 'grayscale(1)', opacity: 0.3 }}><div className="unlock-emoji">👁️</div><div className="unlock-level">LVL 5</div></div>
          <div className="unlock-item locked" style={{ filter: 'grayscale(1)', opacity: 0.3 }}><div className="unlock-emoji">🔮</div><div className="unlock-level">LVL 10</div></div>
          <div className="unlock-item locked" style={{ filter: 'grayscale(1)', opacity: 0.3 }}><div className="unlock-emoji">⚡</div><div className="unlock-level">LVL 15</div></div>
          <div className="unlock-item locked" style={{ filter: 'grayscale(1)', opacity: 0.3 }}><div className="unlock-emoji">👑</div><div className="unlock-level">LVL 20</div></div>
        </div>
      </div>

      <div id="share-card" className="share-card">
        <div className="share-card-top">
          <div>
            <div className="share-hunter-name">{pathConfig.title}</div>
            <div className="share-hunter-title">// {pathConfig.worldLabel} - {rank} RANK</div>
          </div>
          <div className="share-rank">{rank}</div>
        </div>
        <div className="share-card-bottom">
          <div className="share-stat"><div className="share-stat-val">{totalXP}</div><div className="share-stat-label">TOTAL XP</div></div>
          <div className="share-stat"><div className="share-stat-val">{Number(profile?.current_streak || 0)}</div><div className="share-stat-label">DAY STREAK</div></div>
          <div className="share-stat"><div className="share-stat-val">{level}</div><div className="share-stat-label">LEVEL</div></div>
        </div>
        <div className="share-badges">
          <div className="share-badge gold">{pathConfig.worldLabel}</div>
          <div className="share-badge cyan">{rank}-RANK HUNTER</div>
          <div className="share-badge purple">ZBXP CLOSED BETA</div>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn-cyan"
            onClick={async () => {
              const summary = `${pathConfig.title} | ${rank}-RANK | ${totalXP} XP | ${Number(profile?.current_streak || 0)} day streak`
              try {
                await navigator.clipboard.writeText(summary)
              } catch {
                // noop for unsupported clipboard contexts
              }
            }}
          >
            ⬇ GENERATE SHARE CARD
          </button>
        </div>
      </div>
    </section>
  )
}

function QuestsPage({ onProfileRefresh, onXpGain }) {
  const ACTIVE_QUEST_UI_LIMIT = 10
  const { profile, pathConfig } = useApp()
  const [availableQuests, setAvailableQuests] = useState([])
  const [activeQuests, setActiveQuests] = useState([])
  const [history, setHistory] = useState([])
  const [selectedQuestId, setSelectedQuestId] = useState('')
  const [selectedActiveId, setSelectedActiveId] = useState('')
  const [selectedHistoryId, setSelectedHistoryId] = useState('')
  const [noteDrafts, setNoteDrafts] = useState({})
  const [loading, setLoading] = useState(true)
  const [questMessage, setQuestMessage] = useState('')
  const [error, setError] = useState('')

  const loadQuestData = async () => {
    setLoading(true)
    setError('')

    const availablePromise = supabase
      .from('quests')
      .select('*')
      .eq('is_active', true)
      .eq('path', profile.path)
      .order('xp_reward', { ascending: true })

    const historyPromise = supabase
      .from('quest_completions')
      .select(`
        id,
        completed_at,
        optional_note,
        user_active_quests (
          id,
          status,
          selected_at,
          quests (
            id,
            title,
            xp_reward,
            category,
            difficulty
          )
        )
      `)
      .eq('user_id', profile.id)
      .order('completed_at', { ascending: false })
      .limit(25)

    // Prefer newer schema first (status + selected_at), then fall back.
    let activeRes = await supabase
      .from('user_active_quests')
      .select('id, selected_at, status, quest:quests(*)')
      .eq('user_id', profile.id)
      .order('selected_at', { ascending: false })

    if (activeRes.error) {
      const msg = String(activeRes.error.message || '').toLowerCase()
      const missingSelectedAt = msg.includes('selected_at') && msg.includes('does not exist')
      const missingStatus = msg.includes('status') && msg.includes('does not exist')
      if (missingSelectedAt || missingStatus) {
        activeRes = await supabase
          .from('user_active_quests')
          .select('id, created_at, quest:quests(*)')
          .eq('user_id', profile.id)
          .order('created_at', { ascending: false })
      }
    }

    const [availableRes, historyRes] = await Promise.all([availablePromise, historyPromise])

    if (availableRes.error || activeRes.error || historyRes.error) {
      setError(availableRes.error?.message || activeRes.error?.message || historyRes.error?.message || 'Load failed')
      setLoading(false)
      return
    }

    setAvailableQuests(availableRes.data || [])
    const normalizedActive = (activeRes.data || []).filter((row) => {
      const status = String(row?.status || '').toLowerCase()
      return !['completed', 'done', 'archived', 'inactive'].includes(status)
    })
    setActiveQuests(normalizedActive)
    const normalizedHistory = (historyRes.data || []).map((row) => {
      const activeQuest = Array.isArray(row.user_active_quests) ? row.user_active_quests[0] : row.user_active_quests
      const quest = Array.isArray(activeQuest?.quests) ? activeQuest.quests[0] : activeQuest?.quests
      return {
        id: row.id,
        completed_at: row.completed_at,
        note: row.optional_note,
        quest,
      }
    })

    setHistory(normalizedHistory)
    setLoading(false)
  }

  useEffect(() => {
    loadQuestData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, profile.path])

  const onSelectQuest = async (questId) => {
    setError('')
    setQuestMessage('')
    let rpcRes = await supabase.rpc('select_quest', { p_quest_id: questId })
    if (rpcRes.error) {
      const msg = String(rpcRes.error.message || '').toLowerCase()
      const duplicateFromRpc = msg.includes('duplicate key value')
      if (duplicateFromRpc) {
        setSelectedQuestId(questId)
        setQuestMessage('Quest is already active.')
        loadQuestData()
        return
      }
      const capBlocked = msg.includes('active quest limit') || msg.includes('max 3')
      if (capBlocked && activeQuests.length < ACTIVE_QUEST_UI_LIMIT) {
        let insertRes = await supabase
          .from('user_active_quests')
          .insert({
            user_id: profile.id,
            quest_id: questId,
            status: 'active',
            selected_at: new Date().toISOString(),
          })
          .select('id')
          .maybeSingle()

        if (insertRes.error) {
          const insertMsg = String(insertRes.error.message || '').toLowerCase()
          const missingCols =
            (insertMsg.includes('selected_at') && insertMsg.includes('does not exist')) ||
            (insertMsg.includes('status') && insertMsg.includes('does not exist'))
          if (missingCols) {
            insertRes = await supabase
              .from('user_active_quests')
              .insert({ user_id: profile.id, quest_id: questId })
              .select('id')
              .maybeSingle()
          }
        }

        if (insertRes.error) {
          const duplicateActiveQuest = String(insertRes.error.message || '').toLowerCase().includes('duplicate key value')
          if (duplicateActiveQuest) {
            setSelectedQuestId(questId)
            setQuestMessage('Quest is already active.')
            loadQuestData()
            return
          }
          setError(`Quest select failed: ${insertRes.error.message}`)
          return
        }
        setSelectedQuestId(questId)
        setQuestMessage('Quest accepted via fallback path.')
        loadQuestData()
        return
      }

      setError(rpcRes.error.message)
      return
    }
    setSelectedQuestId(questId)
    setQuestMessage('Quest accepted and added to Active Missions.')
    loadQuestData()
  }

  const onCompleteQuest = async (activeQuestId) => {
    setError('')
    setQuestMessage('')

    const activeQuest = activeQuests.find((item) => item.id === activeQuestId)
    const questId = activeQuest?.quest_id ?? activeQuest?.quest?.id
    if (!questId) {
      setError('Missing quest id for completion.')
      return
    }

    const beforeXp = Number(profile?.total_xp ?? profile?.xp_total ?? 0)
    let rpcResponse = await supabase.rpc('complete_quest', { p_quest_id: questId })
    if (rpcResponse.error) {
      const message = String(rpcResponse.error.message || '').toLowerCase()
      const missingQuestIdSig =
        message.includes('function public.complete_quest') &&
        message.includes('p_quest_id')
      if (missingQuestIdSig) {
        rpcResponse = await supabase.rpc('complete_quest', {
          p_active_quest_id: activeQuestId,
          p_optional_note: noteDrafts[activeQuestId] || null,
        })
      }
    }
    if (rpcResponse.error) {
      setError(`Quest completion failed: ${rpcResponse.error.message}`)
      return
    }

    const result = Array.isArray(rpcResponse.data) ? rpcResponse.data[0] : rpcResponse.data
    if (import.meta.env.DEV) {
      // Dev instrumentation for XP persistence tracking.
      console.debug('[quest.complete] rpc result', { activeQuestId, questId, result })
    }
    const awardedXp = Number(result?.awarded_xp ?? 0)
    if (awardedXp > 0) {
      onXpGain(awardedXp)
    }

    setSelectedActiveId(activeQuestId)
    setQuestMessage('Quest completion logged.')
    let refreshedProfile = await onProfileRefresh()
    if (!refreshedProfile) {
      setError('Quest completed, but profile refresh failed. Tap Retry Profile Load above.')
      return
    }
    const afterXp = Number(refreshedProfile?.total_xp ?? refreshedProfile?.xp_total ?? 0)
    if (awardedXp > 0 && afterXp <= beforeXp) {
      const persistRes = await incrementProfileXp(profile.id, awardedXp)
      if (persistRes.error) {
        setError(`Quest completed but XP persist failed: ${persistRes.error.message}`)
        return
      }
      refreshedProfile = await onProfileRefresh()
      setQuestMessage(`Quest completion logged. +${awardedXp} XP persisted.`)
    }
    if (import.meta.env.DEV) {
      console.debug('[quest.complete] profile refresh result', {
        after_total_xp: Number(refreshedProfile?.total_xp ?? refreshedProfile?.xp_total ?? 0),
      })
    }
    loadQuestData()
  }

  const activeQuestIds = new Set(activeQuests.map((item) => item.quest?.id))
  const questClass = (category) => {
    const key = String(category || '').toLowerCase()
    if (key === 'study') return 'q-study'
    if (key === 'coding') return 'q-coding'
    if (key === 'gym') return 'q-gym'
    if (key === 'business') return 'q-business'
    return ''
  }
  const questIcon = (category) => {
    const key = String(category || '').toLowerCase()
    if (key === 'study') return '📖'
    if (key === 'coding') return '💻'
    if (key === 'gym') return '⚔️'
    if (key === 'business') return '💼'
    return '🎯'
  }
  const groupedAvailable = availableQuests.reduce((acc, quest) => {
    const key = String(quest.category || 'other').toLowerCase()
    if (!acc[key]) acc[key] = []
    acc[key].push(quest)
    return acc
  }, {})

  return (
    <section className="tab-content active">
      <div className="panel">
        <div className="panel-title">{pathConfig.questBoardTitle}</div>
        <div className="panel-sub">{pathConfig.questBoardFlavor}</div>
      </div>

      {error ? <p className="error-text">{error}</p> : null}
      {questMessage ? <p className="muted">{questMessage}</p> : null}

      <div className="panel">
        <div className="panel-title">Guild Quest Board</div>
        <div className="panel-sub">// pick high-leverage missions - run them clean - climb the ranks</div>

        {loading ? (
          <p className="muted">Loading quests...</p>
        ) : (
          <div className="quest-list">
            {['study', 'coding', 'gym', 'business'].map((category) => (
              <div key={category}>
                {groupedAvailable[category]?.length ? <div className="section-label">{category.toUpperCase()}</div> : null}
                {groupedAvailable[category]?.map((quest) => {
                  const disabled = activeQuestIds.has(quest.id) || activeQuests.length >= ACTIVE_QUEST_UI_LIMIT
                  return (
                    <article
                      key={quest.id}
                      className={cx('quest-item', questClass(quest.category), selectedQuestId === quest.id && 'is-selected')}
                      onClick={() => {
                        setSelectedQuestId(quest.id)
                        setQuestMessage('Quest selected. Click Accept to add it.')
                      }}
                    >
                      <div className="quest-icon">{questIcon(quest.category)}</div>
                      <div className="quest-info">
                        <div className="quest-name">{quest.title}</div>
                        <div className="quest-desc">
                          // {quest.flavor_text || `${quest.category} - ${quest.difficulty}`}
                        </div>
                      </div>
                      <div className="quest-xp">+{quest.xp_reward} XP</div>
                      <button type="button" className="quest-complete-btn" onClick={() => onSelectQuest(quest.id)} disabled={disabled}>
                        {activeQuestIds.has(quest.id) ? 'Selected' : 'Accept'}
                      </button>
                    </article>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-title">Active Missions</div>
        <div className="panel-sub">// your current active quests - max {ACTIVE_QUEST_UI_LIMIT} at a time</div>
        {activeQuests.length === 0 ? <p className="muted">No active quests yet.</p> : null}
        <div className="quest-list">
          {activeQuests.map((entry) => (
            <article
              key={entry.id}
              className={cx('quest-item', questClass(entry.quest?.category), selectedActiveId === entry.id && 'is-selected')}
              onClick={() => {
                setSelectedActiveId(entry.id)
                setQuestMessage(`Active mission selected: ${entry.quest?.title || 'Unknown'}`)
              }}
            >
              <div className="quest-icon">{questIcon(entry.quest?.category)}</div>
              <div className="quest-info">
                <div className="quest-name">{entry.quest?.title}</div>
                <div className="quest-desc">{entry.quest?.category} - {entry.quest?.difficulty}</div>
                <label>
                  Quick note (optional)
                  <input
                    value={noteDrafts[entry.id] || ''}
                    onChange={(event) =>
                      setNoteDrafts((prev) => ({
                        ...prev,
                        [entry.id]: event.target.value,
                      }))
                    }
                    maxLength={180}
                    placeholder="What was shipped / learned"
                  />
                </label>
              </div>
              <div className="quest-xp">+{entry.quest?.xp_reward || 0} XP</div>
              <button type="button" className="quest-complete-btn" onClick={() => onCompleteQuest(entry.id)}>
                Complete
              </button>
            </article>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>Quest History</h3>
        <ul className="clean-list">
          {history.map((item) => (
            <li
              key={item.id}
              className={cx('history-item', selectedHistoryId === item.id && 'is-selected')}
              onClick={() => {
                setSelectedHistoryId(item.id)
                setQuestMessage(`History selected: ${item.quest?.title || 'Unknown quest'}`)
              }}
              style={{ cursor: 'pointer' }}
            >
              <strong>{item.quest?.title}</strong>
              <span className="muted">{item.quest?.category} • {item.quest?.xp_reward} XP</span>
              <span className="muted">{new Date(item.completed_at).toLocaleString()}</span>
              {item.note ? <span className="muted">Note: {item.note}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function BossFightPage() {
  const [hp, setHp] = useState(68)
  const [attacks, setAttacks] = useState(0)
  const [timeLeft, setTimeLeft] = useState(4 * 60 * 60 + 22 * 60 + 16)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const interval = setInterval(() => {
      setTimeLeft((prev) => Math.max(0, prev - 1))
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const attackBoss = () => {
    if (hp <= 0) return
    setAttacks((prev) => prev + 1)
    setHp((prev) => {
      const next = Math.max(0, prev - 5)
      if (next === 0) {
        setMessage('Boss defeated. Rewards unlocked.')
      } else {
        setMessage(`Direct hit. Boss HP now ${next}%.`)
      }
      return next
    })
  }

  const hh = String(Math.floor(timeLeft / 3600)).padStart(2, '0')
  const mm = String(Math.floor((timeLeft % 3600) / 60)).padStart(2, '0')
  const ss = String(timeLeft % 60).padStart(2, '0')

  return (
    <section className="tab-content active">
      <div className="boss-card">
        <div className="boss-header">
          <div>
            <div className="boss-tag">⚔️ WEEKLY BOSS - MONDAY RESET</div>
            <div className="boss-name">Shadow Gate: Iron Monarch</div>
          </div>
          <div>
            <div className="boss-timer">{hh}:{mm}:{ss}</div>
            <div className="boss-timer-label">TIME REMAINING</div>
          </div>
        </div>
        <div className="boss-hp-label">
          <span>BOSS HP</span>
          <span>{hp}%</span>
        </div>
        <div className="boss-hp-track">
          <div className="boss-hp-fill" style={{ width: `${hp}%` }} />
        </div>
        <div className="boss-rewards">
          <div className="reward-chip xp">+200 XP</div>
          <div className="reward-chip title">TITLE: IRON SLAYER</div>
          <div className="reward-chip badge">RAID BADGE</div>
        </div>
        <div className="actions" style={{ marginTop: '12px' }}>
          <button type="button" className="btn btn-red" onClick={attackBoss}>⚔️ ATTACK BOSS</button>
        </div>
        <p className="muted">Party attacks: {attacks}</p>
        {message ? <p className="muted">{message}</p> : null}
      </div>

      <div className="mega-boss-card">
        <div className="boss-name" style={{ color: 'var(--gold)', fontSize: '16px', marginBottom: '10px' }}>
          MONTHLY MEGA-BOSS
        </div>
        <div className="boss-hp-label">
          <span>CONTRIBUTION PROGRESS</span>
          <span>24%</span>
        </div>
        <div className="ch-track" style={{ borderColor: 'rgba(245,158,11,0.2)' }}>
          <div className="ch-fill" style={{ width: '24%', background: 'linear-gradient(90deg,#92400e,var(--gold))' }} />
        </div>
        <div className="boss-rewards" style={{ marginTop: '12px' }}>
          <div className="reward-chip title">LEGENDARY TITLE</div>
          <div className="reward-chip badge">AVATAR FRAME</div>
          <div className="reward-chip xp">+500 XP</div>
        </div>
      </div>
    </section>
  )
}

function SkillTreePage() {
  const { profile } = useApp()
  const [spent, setSpent] = useState(0)
  const [unlocked, setUnlocked] = useState(new Set(['streak1']))
  const total = getProfileXp(profile)
  const available = Math.max(0, total - spent)

  const unlock = (id, cost) => {
    if (unlocked.has(id) || cost > available) return
    setUnlocked((prev) => new Set(prev).add(id))
    setSpent((prev) => prev + cost)
  }

  const node = (id, name, desc, cost) => {
    const isUnlocked = unlocked.has(id)
    return (
      <button
        key={id}
        type="button"
        className={cx('skill-node', isUnlocked ? 'unlocked' : 'locked')}
        onClick={() => unlock(id, cost)}
      >
        <div className="skill-node-name">{name}</div>
        <div className="skill-node-desc">{desc}</div>
        <div className="skill-node-cost">{cost} XP {isUnlocked ? '✓' : ''}</div>
      </button>
    )
  }

  return (
    <section className="tab-content active">
      <div className="panel">
        <div className="panel-title">Skill Tree</div>
        <div className="panel-sub">// spend XP to unlock passive abilities - choose your path wisely</div>
        <div style={{ marginTop: '12px' }}>
          <span className="section-label">Available XP to spend</span>
          <strong>{available} XP</strong>
        </div>

        <div className="skill-tree">
          <div className="skill-branch branch-endurance">
            <div className="skill-branch-title">⚡ Endurance</div>
            {node('streak1', 'Streak Shield I', 'Survive 1 missed day without breaking streak', 500)}
            {node('streak2', 'Streak Shield II', 'Bank up to 2 streak protection tokens', 1000)}
          </div>

          <div className="skill-branch branch-power">
            <div className="skill-branch-title">🔥 Power</div>
            {node('xp1', 'XP Boost I', 'Activate 1.5x XP for one weekend per month', 800)}
            {node('xp2', 'XP Boost II', 'Stack to 2x XP for one weekend per month', 1800)}
          </div>

          <div className="skill-branch branch-shadow">
            <div className="skill-branch-title">🌑 Shadow</div>
            {node('shadow1', 'Hidden S-Rank Quests', 'Unlock high-risk, high-XP missions', 1200)}
            {node('shadow2', 'Shadow Clone Tasks', 'Duplicate 1 quest completion per week', 2000)}
          </div>
        </div>
      </div>
    </section>
  )
}

function GuildPage() {
  const { profile } = useApp()
  const [groups, setGroups] = useState([])
  const [allGroups, setAllGroups] = useState([])
  const [memberCounts, setMemberCounts] = useState({})
  const [guildPreviewBoard, setGuildPreviewBoard] = useState([])
  const [communityMembers, setCommunityMembers] = useState([])
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [challengeTitle, setChallengeTitle] = useState('Weekly Raid: 200 total completions')
  const [newGroupName, setNewGroupName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [selectedGuildName, setSelectedGuildName] = useState('')
  const [guildTab, setGuildTab] = useState('members')
  const [directoryJoinTarget, setDirectoryJoinTarget] = useState(null)
  const [showJoinOverlay, setShowJoinOverlay] = useState(false)
  const [joinOverlayName, setJoinOverlayName] = useState('')
  const [joinOverlayRank, setJoinOverlayRank] = useState('E')
  const [guildXp, setGuildXp] = useState(6800)
  const [guildXpToNext, setGuildXpToNext] = useState(10000)
  const [guildLevel, setGuildLevel] = useState(11)
  const [bossHp, setBossHp] = useState(8400)
  const [bossDefeated, setBossDefeated] = useState(false)
  const [bossKillLog, setBossKillLog] = useState([
    { id: 1, name: 'Shadow Monarch', tier: 'III', mvp: 'IRONWILL', when: '2D AGO', reward: '+500 XP' },
  ])
  const [guildQuests, setGuildQuests] = useState([
    { id: 1, name: 'Collective Iron Will', desc: 'Guild members complete 25 workout sessions this week.', xp: 500, total: 25, current: 18, done: false },
    { id: 2, name: 'Thousand Reps Challenge', desc: 'Log 1000 total reps across all members.', xp: 300, total: 1000, current: 740, done: false },
    { id: 3, name: 'No Days Off Week', desc: 'Every member logs at least one session each day.', xp: 800, total: 7, current: 4, done: false },
  ])
  const [feedEntries, setFeedEntries] = useState([
    { id: 1, icon: '⚡', text: 'Guild systems online. Start contributing.', xp: '+0 XP', time: 'NOW' },
  ])
  const [chatDraft, setChatDraft] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const toXpValue = (row) => Number(row?.xp_total ?? row?.total_xp ?? row?.xp ?? 0)
  const normalizeProfileStats = (pr, fallbackId) => ({
    id: pr?.id || fallbackId,
    username: safeDisplayName(
      {
        user_id: pr?.id || fallbackId,
        username: pr?.username,
        display_name: pr?.display_name,
      },
      fallbackId,
    ),
    xp: Number(pr?.xp ?? pr?.total_xp ?? pr?.xp_total ?? 0),
    streak: Number(pr?.current_streak ?? 0),
  })

  const loadGroups = async () => {
    setError('')
    const { data, error: groupsError } = await supabase
      .from('group_members')
      .select('group_id, role, group:groups(id, name, created_by, invite_code)')
      .eq('user_id', profile.id)

    if (groupsError) {
      setError(groupsError.message)
      return
    }

    const nextGroups = (data || []).map((row) => row.group).filter(Boolean)
    setGroups(nextGroups)
    if (!selectedGroupId && nextGroups.length > 0) {
      setSelectedGroupId(nextGroups[0].id)
    }
  }

  const loadAllGroups = async () => {
    let allGroupsRes = await supabase
      .from('groups')
      .select('id, name, created_by, invite_code, capacity, created_at')
      .order('name', { ascending: true })

    if (allGroupsRes.error) {
      const msg = String(allGroupsRes.error.message || '').toLowerCase()
      if (msg.includes('column') && msg.includes('capacity')) {
        allGroupsRes = await supabase
          .from('groups')
          .select('id, name, created_by, invite_code, created_at')
          .order('name', { ascending: true })
      }
    }

    if (allGroupsRes.error) {
      setError((prev) => prev || allGroupsRes.error.message)
      return
    }

    setAllGroups(allGroupsRes.data || [])
  }

  const loadMemberCounts = async () => {
    const { data, error: memberError } = await supabase
      .from('group_members')
      .select('group_id')

    if (memberError) {
      setError((prev) => prev || memberError.message)
      return
    }

    const counts = {}
    for (const row of data || []) {
      counts[row.group_id] = (counts[row.group_id] || 0) + 1
    }
    setMemberCounts(counts)
  }

  const loadGuildPreviewBoard = async (groupId) => {
    if (!groupId) {
      setGuildPreviewBoard([])
      return
    }
    const boardRes = await supabase.rpc('get_leaderboard', {
      p_group_id: groupId,
      p_timeframe: 'all_time',
    })
    if (!boardRes.error) {
      setGuildPreviewBoard((boardRes.data || []).slice(0, 5))
      return
    }

    // Graceful fallback when leaderboard RPC is unavailable or blocked by RLS.
    const membersRes = await supabase
      .from('group_members')
      .select('user_id')
      .eq('group_id', groupId)
      .limit(25)

    if (membersRes.error) {
      setGuildPreviewBoard([])
      setError((prev) => prev || `Guild preview unavailable: ${boardRes.error.message}`)
      return
    }

    const memberIds = [...new Set((membersRes.data || []).map((row) => row.user_id).filter(Boolean))]
    if (memberIds.length === 0) {
      setGuildPreviewBoard([])
      return
    }

    let profileRes = await supabase
      .from('profiles')
      .select('id, username, total_xp, xp_total')
      .in('id', memberIds)
      .limit(25)

    if (profileRes.error && String(profileRes.error.message || '').toLowerCase().includes('total_xp')) {
      profileRes = await supabase
        .from('profiles')
        .select('id, username, xp_total')
        .in('id', memberIds)
        .limit(25)
    }

    if (profileRes.error) {
      setGuildPreviewBoard([])
      setError((prev) => prev || `Guild preview unavailable: ${profileRes.error.message}`)
      return
    }

    const normalized = (profileRes.data || [])
      .map((row) => ({
        user_id: row.id,
        username: row.username,
        xp_total: toXpValue(row),
      }))
      .sort((a, b) => b.xp_total - a.xp_total)
      .slice(0, 5)

    setGuildPreviewBoard(normalized)
  }

  const loadCommunityMembers = async (groupId) => {
    if (!groupId) {
      setCommunityMembers([])
      return
    }

    const memberRes = await supabase
      .from('group_members')
      .select('user_id, role')
      .eq('group_id', groupId)
      .limit(50)

    if (memberRes.error) {
      setError((prev) => prev || memberRes.error.message)
      setCommunityMembers([])
      return
    }

    const ids = [...new Set((memberRes.data || []).map((row) => row.user_id).filter(Boolean))]
    if (ids.length === 0) {
      setCommunityMembers([])
      return
    }

    const profileCandidates = [
      'id, username, display_name, xp, current_streak',
      'id, username, display_name, total_xp, current_streak',
      'id, username, display_name, xp_total, current_streak',
      'id, username, display_name, xp',
      'id, username, display_name',
    ]
    let profileRes = null
    for (const fields of profileCandidates) {
      const res = await supabase
        .from('profiles')
        .select(fields)
        .in('id', ids)
      if (!res.error) {
        profileRes = res
        break
      }
    }

    if (!profileRes || profileRes.error) {
      setError((prev) => prev || profileRes?.error?.message || 'Unable to load community profiles.')
      setCommunityMembers([])
      return
    }

    const byId = new Map((profileRes.data || []).map((row) => [row.id, row]))
    const merged = (memberRes.data || []).map((row) => {
      const pr = byId.get(row.user_id)
      const normalized = normalizeProfileStats(pr, row.user_id)
      return {
        user_id: row.user_id,
        role: row.role || 'member',
        xp: normalized.xp,
        streak: normalized.streak,
        username: normalized.username,
      }
    })
    setCommunityMembers(merged)
  }

  const selectGuildContext = (groupId, guildName) => {
    setSelectedGroupId(groupId)
    setSelectedGuildName(guildName)
    setGuildTab('members')
  }

  const refreshGuildCommunity = async (groupId) => {
    await loadGroups()
    await loadAllGroups()
    await loadMemberCounts()
    await loadCommunityMembers(groupId)
    await loadGuildPreviewBoard(groupId)
  }

  const joinGuildById = async (groupId) => {
    const authRes = await supabase.auth.getUser()
    const userId = authRes?.data?.user?.id || profile?.id
    if (!userId) {
      throw new Error('Not signed in')
    }

    let insertRes = await supabase
      .from('group_members')
      .insert({ group_id: groupId, user_id: userId, role: 'member' }, { returning: 'minimal' })

    if (insertRes.error) {
      const msg = String(insertRes.error.message || '').toLowerCase()
      const missingRole = msg.includes('role') && msg.includes('does not exist')
      if (missingRole) {
        insertRes = await supabase
          .from('group_members')
          .insert({ group_id: groupId, user_id: userId }, { returning: 'minimal' })
      }
    }

    if (insertRes.error && !String(insertRes.error.message || '').toLowerCase().includes('duplicate')) {
      throw insertRes.error
    }

    return groupId
  }

  useEffect(() => {
    loadGroups()
    loadAllGroups()
    loadMemberCounts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id])

  useEffect(() => {
    loadGuildPreviewBoard(selectedGroupId)
    loadCommunityMembers(selectedGroupId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId])

  const onCreateGuild = async (event) => {
    event.preventDefault()
    setError('')
    setMessage('')
    if (!newGroupName.trim()) return

    const createRes = await supabase.rpc('create_guild', { p_name: newGroupName.trim() })
    if (createRes.error) {
      setError(createRes.error.message)
      return
    }
    setMessage('Guild created.')
    setNewGroupName('')
    loadGroups()
  }

  const onJoinGuild = async (event) => {
    event.preventDefault()
    setError('')
    setMessage('')
    const code = joinCode.trim().toUpperCase()
    if (!code) return

    const joinRes = await supabase.rpc('join_guild_by_code', { p_code: code })
    if (joinRes.error) {
      setError(joinRes.error.message)
      return
    }
    setMessage('Joined guild.')
    setJoinCode('')
    setDirectoryJoinTarget(null)
    await loadGroups()
    await loadAllGroups()
    const directGroup = await supabase
      .from('groups')
      .select('id, name')
      .eq('invite_code', code)
      .maybeSingle()
    const selected =
      directGroup.data ||
      allGroups.find((entry) => String(entry.invite_code || '').toUpperCase() === code) ||
      groups.find((entry) => String(entry.invite_code || '').toUpperCase() === code)
    if (selected?.id) {
      selectGuildContext(selected.id, selected.name)
      setJoinOverlayName(selected.name)
      setJoinOverlayRank('E')
      setShowJoinOverlay(true)
      await refreshGuildCommunity(selected.id)
    }
  }

  const addGuildFeed = (icon, text, xp = '') => {
    setFeedEntries((prev) => [{ id: Date.now() + Math.random(), icon, text, xp, time: 'JUST NOW' }, ...prev].slice(0, 40))
  }

  const addGuildXp = (amount) => {
    const inc = Number(amount || 0)
    if (inc <= 0) return
    setGuildXp((prev) => {
      let next = prev + inc
      let nextLevel = guildLevel
      let nextCap = guildXpToNext
      while (next >= nextCap) {
        next -= nextCap
        nextLevel += 1
        nextCap = Math.round(nextCap * 1.4)
      }
      setGuildLevel(nextLevel)
      setGuildXpToNext(nextCap)
      return next
    })
  }

  const respawnBoss = () => {
    setBossHp(10000)
    setBossDefeated(false)
    addGuildFeed('💀', 'New raid boss has appeared. Rally the guild.', '')
    setMessage('A new boss has spawned.')
  }

  const attackBoss = (damage, ultimate = false) => {
    if (bossDefeated || bossHp <= 0) {
      setMessage('Boss already defeated. Respawn to continue raid.')
      return
    }
    const crit = Math.random() < (ultimate ? 0.5 : 0.15)
    const final = crit ? Math.round(damage * 2.5) : damage
    const nextHp = Math.max(0, bossHp - final)
    setBossHp(nextHp)
    addGuildXp(Math.round(final / 10))
    addGuildFeed('⚔️', `${safeDisplayName(profile, profile.id)} dealt ${final} damage to guild boss${crit ? ' (CRIT)' : ''}.`, `+${Math.round(final / 10)} XP`)

    if (nextHp <= 0) {
      setBossDefeated(true)
      addGuildXp(150)
      addGuildFeed('🏆', 'Guild defeated SHADOW MONARCH.', '+500 XP')
      setBossKillLog((prev) => ([
        {
          id: Date.now(),
          name: 'Shadow Monarch',
          tier: 'III',
          mvp: safeDisplayName(profile, profile.id),
          when: 'JUST NOW',
          reward: '+500 XP',
        },
        ...prev,
      ]).slice(0, 8))
      setMessage('Boss defeated. Claim loot and respawn when ready.')
    }
  }

  const contributeGuildQuest = (questId) => {
    const contribution = Math.floor(Math.random() * 3) + 1
    setGuildQuests((prev) =>
      prev.map((quest) => (quest.id === questId ? { ...quest, current: Math.min(quest.total, quest.current + contribution) } : quest)),
    )
    addGuildXp(10)
    addGuildFeed('📜', `${profile.username || 'You'} contributed to a guild quest.`, '+10 XP')
  }

  const completeGuildQuest = (questId) => {
    const quest = guildQuests.find((item) => item.id === questId)
    if (!quest || quest.done || quest.current < quest.total) return
    setGuildQuests((prev) => prev.map((item) => (item.id === questId ? { ...item, done: true } : item)))
    addGuildXp(quest.xp)
    addGuildFeed('🏆', `Guild quest "${quest.name}" completed.`, `+${quest.xp} XP`)
  }

  const sendGuildChat = () => {
    const msg = chatDraft.trim()
    if (!msg) return
    addGuildFeed('💬', `${profile.username || 'You'}: ${msg}`)
    setChatDraft('')
  }

  const openJoinFromDirectory = async (group) => {
    const isMember = groups.some((entry) => entry.id === group.id)
    if (isMember) {
      selectGuildContext(group.id, group.name)
      await refreshGuildCommunity(group.id)
      return
    }

    setError('')
    setMessage('')
    try {
      await joinGuildById(group.id)
    } catch (joinError) {
      setError(String(joinError?.message || joinError))
      return
    }

    selectGuildContext(group.id, group.name)
    setJoinOverlayName(group.name)
    setJoinOverlayRank('E')
    setShowJoinOverlay(true)
    setMessage(`Joined ${group.name}.`)
    await refreshGuildCommunity(group.id)
  }

  const onCreateChallenge = async () => {
    if (!selectedGroupId) {
      setError('Select a guild first before creating a raid challenge.')
      return
    }
    if (!challengeTitle.trim()) {
      setError('Add a challenge title first.')
      return
    }
    if (!groups.some((group) => group.id === selectedGroupId)) {
      setError('You must be a member of this guild to create a raid challenge.')
      return
    }
    setError('')
    setMessage('')
    const { error: challengeError } = await supabase.from('challenges').insert({
      group_id: selectedGroupId,
      title: challengeTitle.trim(),
      created_by: profile.id,
    })
    if (challengeError) {
      setError(challengeError.message)
      return
    }
    setMessage('Raid challenge created.')
  }

  const selectedGuild = allGroups.find((group) => group.id === selectedGroupId) || groups.find((group) => group.id === selectedGroupId)
  const selectedMembers = Number(memberCounts[selectedGroupId] || 0)
  const selectedCapacity = Number(selectedGuild?.capacity || 10)
  const selectedOpenSpots = Math.max(0, selectedCapacity - selectedMembers)
  const viewerName = safeDisplayName(profile, profile?.id)
  const selectedGuildTitle = selectedGuildName || selectedGuild?.name || 'IRON WOLVES'
  const bossContributors = [...communityMembers]
    .sort((a, b) => Number(b.xp || 0) - Number(a.xp || 0))
    .slice(0, 5)

  return (
    <section className="tab-content active guild-red-v1">
      {showJoinOverlay ? (
        <div className="join-overlay active" onClick={() => setShowJoinOverlay(false)}>
          <div className="join-card" onClick={(event) => event.stopPropagation()}>
            <div className="join-title">// NEW HUNTER JOINS THE GUILD</div>
            <div className="join-rank-badge">{joinOverlayRank}</div>
            <div className="join-name">{viewerName}</div>
            <div className="join-subtitle">{joinOverlayName.toUpperCase()} • NEW ARRIVAL</div>
            <div className="join-stats-row">
              <div className="join-stat"><div className="join-stat-val">{levelFromXp(getProfileXp(profile))}</div><div className="join-stat-label">LEVEL</div></div>
              <div className="join-stat"><div className="join-stat-val">{getProfileXp(profile)}</div><div className="join-stat-label">XP</div></div>
              <div className="join-stat"><div className="join-stat-val">{Number(profile?.current_streak ?? 0)}</div><div className="join-stat-label">STREAK</div></div>
            </div>
            <div className="join-welcome">⚔ WELCOME TO THE GUILD COMMUNITY</div>
            <button type="button" className="join-close" onClick={() => setShowJoinOverlay(false)}>ACKNOWLEDGE</button>
          </div>
        </div>
      ) : null}

      {error ? <p className="error-text">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}

      <div className="guild-app">
        <div className="guild-topbar">
          <div className="guild-topbar-left">
            <button type="button" className="btn btn-cyan" onClick={() => { loadGroups(); loadMemberCounts() }}>REFRESH MY GUILDS</button>
            <button type="button" className="btn btn-cyan" onClick={() => { loadAllGroups(); loadMemberCounts() }}>REFRESH WORLD GUILDS</button>
          </div>
          <div className="guild-topbar-right">
            <form className="guild-inline-form" onSubmit={onCreateGuild}>
              <input className="zbxp-input" value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="Create guild name" maxLength={50} />
              <button type="submit" className="btn btn-purple">CREATE</button>
            </form>
            <form className="guild-inline-form" onSubmit={onJoinGuild}>
              <input className="zbxp-input" value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="Join by code" maxLength={12} />
              <button type="submit" className="btn btn-cyan">JOIN</button>
            </form>
          </div>
        </div>
        <div className="guild-header">
          <div className="guild-header-inner">
            <div className="guild-emblem">⚔</div>
            <div className="guild-hdr-main">
              <div className="guild-name">{selectedGuildTitle}</div>
              <div className="guild-sub">// COMMUNITY • COMPETITION • EXECUTION</div>
              <div className="guild-xp-bar-wrap">
                <div className="guild-xp-bar" style={{ width: `${Math.max(0, Math.min(100, Math.round((guildXp / guildXpToNext) * 100)))}%` }} />
              </div>
              <div className="guild-xp-label"><span>{guildXp.toLocaleString()} XP</span><span>{guildXpToNext.toLocaleString()} XP TO LV.{guildLevel + 1}</span></div>
              <div className="guild-meta-row">
                <span>MEMBERS {selectedMembers}</span>
                <span>OPEN {selectedOpenSpots}</span>
                <span>GUILD LV.{guildLevel}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="guild-tabs">
          <button type="button" className={cx('guild-tab', guildTab === 'members' && 'active')} onClick={() => setGuildTab('members')}>⚔ MEMBERS</button>
          <button type="button" className={cx('guild-tab', guildTab === 'leaderboard' && 'active')} onClick={() => setGuildTab('leaderboard')}>🏆 LEADERBOARD</button>
          <button type="button" className={cx('guild-tab', guildTab === 'boss' && 'active')} onClick={() => setGuildTab('boss')}>💀 BOSS</button>
          <button type="button" className={cx('guild-tab', guildTab === 'quests' && 'active')} onClick={() => setGuildTab('quests')}>📜 QUESTS</button>
          <button type="button" className={cx('guild-tab', guildTab === 'feed' && 'active')} onClick={() => setGuildTab('feed')}>💬 FEED</button>
          <button type="button" className={cx('guild-tab', guildTab === 'directory' && 'active')} onClick={() => setGuildTab('directory')}>🌍 ALL GUILDS</button>
        </div>

        {guildTab === 'members' ? (
          <div className="guild-tab-content active">
            {selectedGroupId ? (
              communityMembers.map((member, index) => {
                const rankInfo = getRankInfo(member.xp)
                return (
                  <button
                    key={member.user_id}
                    type="button"
                    className={cx('member-card', index === 0 && 'leader')}
                  >
                    <div className="member-left">
                      <div className={cx('member-rank', `rank-${String(rankInfo.rank || 'E').toLowerCase()}`)}>{rankInfo.rank}</div>
                      <div className="member-meta">
                        <div className="member-name">{member.username}</div>
                        <div className="member-title">{String(member.role || 'member').toUpperCase()} • STREAK {member.streak || 0}</div>
                      </div>
                    </div>
                    <div className="member-right">
                      <div className="member-xp">{Number(member.xp || 0).toLocaleString()} XP</div>
                    </div>
                  </button>
                )
              })
            ) : (
              <div className="panel-sub">Join a guild from ALL GUILDS to open your community.</div>
            )}
            {selectedGroupId && communityMembers.length === 0 ? <div className="panel-sub">No members visible yet for this guild.</div> : null}
          </div>
        ) : null}

        {guildTab === 'directory' ? (
          <div className="guild-tab-content active">
            <div className="panel-sub">// click a guild to join instantly and open community</div>
            <div className="guild-directory-grid">
              {allGroups.map((group) => {
                const isMember = groups.some((entry) => entry.id === group.id)
                const capacity = Number(group.capacity || 10)
                const members = Number(memberCounts[group.id] || 0)
                const openSpots = Math.max(0, capacity - members)
                return (
                  <button
                    key={group.id}
                    type="button"
                    className={cx('guild-directory-card', selectedGroupId === group.id && 'active', directoryJoinTarget?.id === group.id && 'focus')}
                    onClick={() => {
                      setDirectoryJoinTarget(group)
                      openJoinFromDirectory(group)
                    }}
                  >
                    <div className="guild-directory-title">{group.name}</div>
                    <div className="guild-directory-sub">{isMember ? 'Already joined' : 'Open join'}</div>
                    <div className="guild-directory-meta">{members}/{capacity} members • {openSpots} open</div>
                  </button>
                )
              })}
            </div>
            {allGroups.length === 0 ? <div className="panel-sub">No guilds visible yet. Refresh and verify groups select policy.</div> : null}
          </div>
        ) : null}

        {guildTab === 'leaderboard' ? (
          <div className="guild-tab-content active">
            {guildPreviewBoard.map((row, index) => (
              <div key={`${row.user_id}-${index}`} className={cx('lb-entry', index < 3 && `rank-${index + 1}`)}>
                <div className="lb-pos">#{index + 1}</div>
                <div className="lb-name">{safeDisplayName(row)}</div>
                <div className="lb-xp">{Number(row.xp_total ?? row.xp ?? 0).toLocaleString()} XP</div>
              </div>
            ))}
            {selectedGroupId && guildPreviewBoard.length === 0 ? <div className="panel-sub">No leaderboard rows for this guild yet.</div> : null}
            {!selectedGroupId ? <div className="panel-sub">Join a guild first to view guild leaderboard.</div> : null}
          </div>
        ) : null}

        {guildTab === 'boss' ? (
          <div className="guild-tab-content active">
            <div className="boss-arena">
              {!bossDefeated ? (
                <>
                  <div className="boss-header">
                    <div>
                      <div className="boss-tag">// CURRENT RAID BOSS</div>
                      <div className="boss-name">SHADOW <span>MONARCH</span></div>
                    </div>
                    <div className="boss-avatar">👁️</div>
                  </div>
                  <div className="boss-hp-wrap">
                    <div className="boss-hp-header">
                      <div className="boss-hp-label">BOSS HP</div>
                      <div className="boss-hp-val">{bossHp.toLocaleString()} / 10,000</div>
                    </div>
                    <div className="boss-hp-track">
                      <div className="boss-hp-fill" style={{ width: `${Math.max(0, Math.min(100, Math.round((bossHp / 10000) * 100)))}%` }} />
                      <div className="boss-hp-segments" />
                    </div>
                  </div>
                  <div className="boss-contributors">
                    {bossContributors.map((member, index) => (
                      <div key={`${member.user_id}-${index}`} className={cx('boss-contrib-chip', index === 0 && 'top')}>
                        <span>{member.username}</span>
                        <span className="boss-contrib-dmg">{Number(member.xp || 0).toLocaleString()} XP</span>
                      </div>
                    ))}
                  </div>
                  <div className="boss-attack-row">
                    <button type="button" className="boss-attack-btn" onClick={() => attackBoss(100, false)}>⚔ ATTACK</button>
                    <button type="button" className="boss-attack-btn" onClick={() => attackBoss(250, false)}>🗡 HEAVY STRIKE</button>
                    <button type="button" className="boss-attack-btn special" onClick={() => attackBoss(500, true)}>💥 ULTIMATE</button>
                  </div>
                </>
              ) : (
                <div className="boss-defeated visible">
                  <div className="boss-defeated-title">⚡ BOSS DEFEATED</div>
                  <div className="boss-defeated-sub">THE GUILD PREVAILED - NEW BOSS READY</div>
                  <div className="boss-loot-row">
                    <div className="boss-loot">+500 XP</div>
                    <div className="boss-loot">+150 GUILD XP</div>
                    <div className="boss-loot">RARE DROP</div>
                  </div>
                  <button type="button" className="btn btn-cyan" onClick={respawnBoss} style={{ marginTop: '10px' }}>
                    Respawn Boss
                  </button>
                </div>
              )}
            </div>
            <div className="boss-kill-log">
              <div className="panel-sub">// RAID HISTORY</div>
              {bossKillLog.map((log) => (
                <div key={log.id} className="boss-log-row">
                  <span>{log.name} TIER {log.tier}</span>
                  <span>MVP {log.mvp}</span>
                  <span>{log.reward}</span>
                  <span>{log.when}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {guildTab === 'quests' ? (
          <div className="guild-tab-content active">
            <div className="challenge-card" style={{ marginBottom: '12px' }}>
              <input
                className="zbxp-input"
                value={challengeTitle}
                onChange={(event) => setChallengeTitle(event.target.value)}
                placeholder="Raid challenge title"
                maxLength={120}
                style={{ marginBottom: '8px' }}
              />
              <div className="challenge-title">{challengeTitle}</div>
              <div className="ch-track"><div className="ch-fill" style={{ width: '35%' }} /></div>
              <div className="ch-foot">
                <span>Progress: <span>70 / 200</span></span>
                <span>Deadline: <span>4 days</span></span>
              </div>
              <button type="button" className="btn btn-gold" onClick={onCreateChallenge} disabled={!selectedGroupId}>Create Raid Challenge</button>
              {!selectedGroupId ? <div className="panel-sub" style={{ marginTop: '8px' }}>Join/select a guild first.</div> : null}
            </div>
            {guildQuests.map((quest) => {
              const pct = Math.min(100, Math.round((quest.current / quest.total) * 100))
              return (
                <div key={quest.id} className={cx('gq-card', !quest.done && 'active-quest', quest.done && 'completed-quest')}>
                  {quest.done ? <div className="gq-done-badge">✓ COMPLETE</div> : null}
                  <div className="gq-header">
                    <div className="gq-name">{quest.name}</div>
                    <div className="gq-xp">+{quest.xp}</div>
                  </div>
                  <div className="gq-desc">{quest.desc}</div>
                  <div className="gq-progress-wrap">
                    <div className="gq-progress-header">
                      <span>GUILD PROGRESS</span>
                      <span>{quest.current} / {quest.total} ({pct}%)</span>
                    </div>
                    <div className="gq-track"><div className="gq-fill" style={{ width: `${pct}%` }} /></div>
                  </div>
                  {!quest.done ? (
                    <div className="gq-actions">
                      <button type="button" className="gq-btn contribute" onClick={() => contributeGuildQuest(quest.id)}>⚡ CONTRIBUTE</button>
                      {pct >= 100 ? <button type="button" className="gq-btn complete" onClick={() => completeGuildQuest(quest.id)}>✓ CLAIM</button> : null}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : null}

        {guildTab === 'feed' ? (
          <div className="guild-tab-content active">
            {feedEntries.map((entry) => (
              <div key={entry.id} className="feed-entry">
                <div className="feed-icon">{entry.icon}</div>
                <div className="feed-body">
                  <div className="feed-text">{entry.text}</div>
                  <div className="feed-time">{entry.time}</div>
                </div>
                {entry.xp ? <div className="feed-xp-badge">{entry.xp}</div> : null}
              </div>
            ))}
            <div className="feed-chat-wrap">
              <div className="feed-chat-input-row">
                <input
                  className="feed-chat-input"
                  placeholder="POST TO GUILD FEED..."
                  value={chatDraft}
                  onChange={(event) => setChatDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') sendGuildChat()
                  }}
                  maxLength={120}
                />
                <button type="button" className="feed-chat-send" onClick={sendGuildChat}>SEND</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function buildLast30Days(logs) {
  const days = []
  const map = new Map(logs.map((log) => [log.log_date, log]))
  const now = new Date()

  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setDate(now.getDate() - i)
    const key = formatDate(d)
    const row = map.get(key)
    const notes = String(row?.payload?.notes || '').trim()
    const walkBonus = Boolean(row?.payload?.bonus_walk_45)
    const runBonus = Boolean(row?.payload?.bonus_run_45)
    const bonusText = [walkBonus ? '45m walk' : '', runBonus ? '45m run' : ''].filter(Boolean).join(' + ')
    days.push({
      date: key,
      status: row ? (row.completed ? 'done' : 'missed') : 'neutral',
      tooltip: row
        ? `${key} • ${row.completed ? 'completed' : 'missed'}${bonusText ? ` • ${bonusText}` : ''}${notes ? ` • ${notes}` : ''}`
        : `${key} • no log`,
    })
  }

  return days
}

function calcStreaks(logs) {
  const completed = logs
    .filter((log) => log.completed)
    .map((log) => log.log_date)
    .sort((a, b) => (a < b ? -1 : 1))

  if (completed.length === 0) {
    return { current: 0, longest: 0 }
  }

  let longest = 1
  let run = 1
  for (let i = 1; i < completed.length; i += 1) {
    const prev = new Date(`${completed[i - 1]}T00:00:00`)
    const next = new Date(`${completed[i]}T00:00:00`)
    const diff = Math.round((next - prev) / (1000 * 60 * 60 * 24))
    if (diff === 1) {
      run += 1
      longest = Math.max(longest, run)
    } else {
      run = 1
    }
  }

  const doneSet = new Set(completed)
  let current = 0
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  while (true) {
    const key = formatDate(today)
    if (!doneSet.has(key)) break
    current += 1
    today.setDate(today.getDate() - 1)
  }

  return { current, longest }
}

function fallbackWorkoutContent(path) {
  const normalizedPath = String(path || '').toLowerCase() === 'shadow' ? 'shadow' : 'spartan'
  const planPrefix = normalizedPath === 'shadow' ? 'shadow' : 'spartan'
  const displayPrefix = normalizedPath === 'shadow' ? 'Shadow' : 'Spartan'

  const plans = [
    {
      id: `local-${planPrefix}-machine-fatloss`,
      name: `${displayPrefix} Machine-First Fat Loss`,
      description: '5-day machine-first fat loss + tone program with optional run day.',
      path: normalizedPath,
    },
    {
      id: `local-${planPrefix}-machine-runplus`,
      name: `${displayPrefix} Machine + Run+`,
      description: 'Same split, but run day prioritized as a high-consistency cardio swap.',
      path: normalizedPath,
    },
  ]

  const workoutPlan = {
    push: {
      name: 'PUSH DAY',
      subtitle: 'Chest · Shoulders · Triceps',
      duration: '~55 min',
      xp: 35,
      muscles: {
        primary: ['CHEST', 'FRONT DELT', 'TRICEPS'],
        secondary: ['SIDE DELT', 'SERRATUS'],
      },
      exercises: [
        { name: 'Machine Incline Chest Press', meta: 'UPPER CHEST · 60s REST', sets: '4×12' },
        { name: 'Machine Flat Chest Press', meta: 'MID CHEST · 60s REST', sets: '3×12' },
        { name: 'Cable Chest Fly (low to high)', meta: 'INNER CHEST · 45s REST', sets: '3×15' },
        { name: 'Smith Machine Shoulder Press', meta: 'FRONT DELT · 60s REST', sets: '4×12' },
        { name: 'Dumbbell Lateral Raises', meta: 'SIDE DELT · 30s REST', sets: '4×15' },
        { name: 'Cable Tricep Pushdown', meta: 'TRICEPS · 45s REST', sets: '3×15' },
        { name: 'Overhead Dumbbell Tricep Ext', meta: 'LONG HEAD · 45s REST', sets: '3×12' },
        { name: '20min Treadmill (incline walk)', meta: 'CARDIO · DAILY ❤️ · 3.5mph 12% incline', sets: '20m' },
      ],
    },
    pull: {
      name: 'PULL DAY',
      subtitle: 'Back · Biceps · Rear Delts',
      duration: '~55 min',
      xp: 35,
      muscles: {
        primary: ['BACK', 'BICEPS', 'REAR DELT'],
        secondary: ['TRAPS', 'FOREARMS'],
      },
      exercises: [
        { name: 'Pull-Down Machine (wide grip)', meta: 'LATS WIDTH · 60s REST', sets: '4×12' },
        { name: 'Seated Cable Row', meta: 'MID BACK · 60s REST', sets: '4×12' },
        { name: 'Machine Row', meta: 'THICKNESS · 60s REST', sets: '3×12' },
        { name: 'Cable Straight-Arm Pulldown', meta: 'LATS ISOLATION · 45s REST', sets: '3×15' },
        { name: 'Dumbbell Rear Delt Fly', meta: 'REAR DELT · 30s REST', sets: '3×15' },
        { name: 'Dumbbell Bicep Curl', meta: 'BICEPS · 45s REST', sets: '3×12' },
        { name: 'Cable Hammer Curl', meta: 'BRACHIALIS · 45s REST', sets: '3×12' },
        { name: '20min Treadmill (incline walk)', meta: 'CARDIO · DAILY ❤️ · 3.5mph 12% incline', sets: '20m' },
      ],
    },
    legs: {
      name: 'LEG DAY',
      subtitle: 'Quads · Hamstrings · Glutes',
      duration: '~60 min',
      xp: 40,
      muscles: {
        primary: ['QUADS', 'GLUTES', 'HAMSTRINGS'],
        secondary: ['CALVES', 'HIP FLEXORS'],
      },
      exercises: [
        { name: 'Leg Press Machine', meta: 'QUADS + GLUTES · 90s REST', sets: '4×12' },
        { name: 'Smith Machine Squat', meta: 'FULL LOWER · 90s REST', sets: '3×12' },
        { name: 'Machine Leg Extension', meta: 'QUAD ISOLATION · 60s REST', sets: '3×15' },
        { name: 'Machine Leg Curl (seated)', meta: 'HAMSTRINGS · 60s REST', sets: '3×15' },
        { name: 'Machine Hip Abductor', meta: 'GLUTES + HIP · 45s REST', sets: '3×15' },
        { name: 'Machine Calf Raise', meta: 'CALVES · 30s REST', sets: '4×20' },
        { name: '20min Stairmaster', meta: 'CARDIO · DAILY ❤️ · LEVEL 6-8', sets: '20m' },
      ],
    },
    cardio: {
      name: 'CARDIO + CORE',
      subtitle: 'Conditioning · Abs · Obliques',
      duration: '~50 min',
      xp: 30,
      muscles: {
        primary: ['ABS', 'CORE', 'OBLIQUES'],
        secondary: ['HIP FLEXORS', 'CARDIO'],
      },
      exercises: [
        { name: 'Treadmill Intervals', meta: 'HIIT · 20 MIN TOTAL', sets: '20m' },
        { name: 'Cable Crunch', meta: 'ABS · 30s REST', sets: '4×15' },
        { name: 'Machine Ab Crunch', meta: 'ABS ISOLATION · 30s REST', sets: '3×15' },
        { name: 'Cable Woodchop', meta: 'OBLIQUES · 30s REST', sets: '3×12' },
        { name: 'Hanging Knee Raise', meta: 'LOWER ABS · 30s REST', sets: '3×15' },
        { name: 'Plank Hold', meta: 'CORE STABILITY · 30s REST', sets: '3×45s' },
        { name: 'Stairmaster Cooldown', meta: 'ACTIVE RECOVERY · LEVEL 4', sets: '10m' },
      ],
    },
    fullbody: {
      name: 'FULL BODY',
      subtitle: 'Compound Strength + Tone',
      duration: '~60 min',
      xp: 40,
      muscles: {
        primary: ['CHEST', 'BACK', 'LEGS'],
        secondary: ['SHOULDERS', 'ARMS', 'CORE'],
      },
      exercises: [
        { name: 'Machine Chest Press (flat)', meta: 'CHEST · 60s REST', sets: '3×12' },
        { name: 'Pull-Down Machine', meta: 'BACK · 60s REST', sets: '3×12' },
        { name: 'Leg Press Machine', meta: 'LEGS · 60s REST', sets: '3×12' },
        { name: 'Dumbbell Shoulder Press', meta: 'SHOULDERS · 60s REST', sets: '3×12' },
        { name: 'Cable Bicep Curl', meta: 'BICEPS · 45s REST', sets: '3×12' },
        { name: 'Cable Tricep Pushdown', meta: 'TRICEPS · 45s REST', sets: '3×12' },
        { name: '20min Treadmill (incline walk)', meta: 'CARDIO · DAILY ❤️', sets: '20m' },
      ],
    },
    run: {
      name: 'OUTDOOR RUN',
      subtitle: 'Cardio · Endurance · Mental Clarity',
      duration: '~30+ min',
      xp: 25,
      muscles: {
        primary: ['CARDIO', 'CALVES', 'QUADS'],
        secondary: ['HAMSTRINGS', 'CORE'],
      },
      exercises: [
        { name: '5min Easy Warm-Up Walk', meta: 'WARMUP · PACE: EASY', sets: '5m' },
        { name: '30min Outdoor Run (Zone 2+)', meta: 'BASELINE RUN · 60-80% MAX HR', sets: '30m+' },
        { name: '5min Cooldown Walk', meta: 'SLOW IT DOWN · LET HR DROP', sets: '5m' },
        { name: 'Post-Run Stretch', meta: 'QUADS + CALVES + HIP FLEXORS', sets: '5m' },
      ],
    },
  }

  const day = (planId, dayNumber, title, template) => ({
    id: `${planId}-d${dayNumber}`,
    day_number: dayNumber,
    title,
    template,
  })

  const baseDays = (planId) => [
    day(planId, 1, 'MON • PUSH', workoutPlan.push),
    day(planId, 2, 'TUE • PULL', workoutPlan.pull),
    day(planId, 3, 'WED • LEGS', workoutPlan.legs),
    day(planId, 4, 'THU • CARDIO + CORE', workoutPlan.cardio),
    day(planId, 5, 'FRI • FULL BODY', workoutPlan.fullbody),
    day(planId, 6, 'SAT • OUTDOOR RUN (OPTIONAL SWAP)', workoutPlan.run),
  ]

  const runPlusDays = (planId) => [
    day(planId, 1, 'MON • PUSH', workoutPlan.push),
    day(planId, 2, 'TUE • PULL', workoutPlan.pull),
    day(planId, 3, 'WED • LEGS', workoutPlan.legs),
    day(planId, 4, 'THU • CARDIO + CORE', workoutPlan.cardio),
    day(planId, 5, 'FRI • OUTDOOR RUN (PRIORITY)', workoutPlan.run),
    day(planId, 6, 'SAT • FULL BODY (OPTIONAL SWAP)', workoutPlan.fullbody),
  ]

  return {
    plans,
    byPlan: {
      [plans[0].id]: baseDays(plans[0].id),
      [plans[1].id]: runPlusDays(plans[1].id),
    },
  }
}

function GymPage({ onProfileRefresh, onXpGain }) {
  const { profile, pathConfig } = useApp()
  const [plans, setPlans] = useState([])
  const [selectedPlan, setSelectedPlan] = useState(null)
  const [planDays, setPlanDays] = useState([])
  const [logs, setLogs] = useState([])
  const [logDate, setLogDate] = useState(todayIso())
  const [completed, setCompleted] = useState(true)
  const [bonusWalk45, setBonusWalk45] = useState(false)
  const [bonusRun45, setBonusRun45] = useState(false)
  const [exerciseNotes, setExerciseNotes] = useState('')
  const [selectedDayId, setSelectedDayId] = useState('')
  const [activeExerciseIndex, setActiveExerciseIndex] = useState(0)
  const [doneExerciseKeys, setDoneExerciseKeys] = useState(new Set())
  const [sessionXp, setSessionXp] = useState(0)
  const [logMessage, setLogMessage] = useState('')
  const [error, setError] = useState('')

  const loadGymData = async () => {
    setError('')

    const [plansRes, selectedRes, logsRes] = await Promise.all([
      supabase
        .from('workout_plans')
        .select('*')
        .eq('is_active', true)
        .eq('path', profile.path)
        .order('created_at', { ascending: true }),
      supabase
        .from('user_selected_workout_plans')
        .select('plan_id, plan:workout_plans(*)')
        .eq('user_id', profile.id)
        .maybeSingle(),
      supabase
        .from('workout_logs')
        .select('id, log_date, completed, payload')
        .eq('user_id', profile.id)
        .gte('log_date', formatDate(new Date(Date.now() - 35 * 24 * 60 * 60 * 1000)))
        .order('log_date', { ascending: true }),
    ])

    if (plansRes.error || selectedRes.error || logsRes.error) {
      setError(plansRes.error?.message || selectedRes.error?.message || logsRes.error?.message || 'Load failed')
      return
    }

    const dbPlans = plansRes.data || []
    const useFallback = dbPlans.length === 0
    const fallback = fallbackWorkoutContent(profile.path)
    const effectivePlans = useFallback ? fallback.plans : dbPlans
    setPlans(effectivePlans)
    setLogs(logsRes.data || [])

    const pickedPlan = useFallback
      ? fallback.plans[0]
      : (selectedRes.data?.plan || dbPlans[0] || null)
    setSelectedPlan(pickedPlan)

    if (useFallback) {
      setPlanDays(pickedPlan?.id ? (fallback.byPlan[pickedPlan.id] || []) : [])
      return
    }

    if (pickedPlan?.id) {
      const { data: daysData, error: daysError } = await supabase
        .from('workout_plan_days')
        .select('*')
        .eq('plan_id', pickedPlan.id)
        .order('day_number', { ascending: true })

      if (daysError) {
        setError(daysError.message)
      } else {
        setPlanDays(daysData || [])
      }
    } else {
      setPlanDays([])
    }
  }

  useEffect(() => {
    loadGymData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, profile.path])

  const onSelectPlan = async (planId) => {
    setError('')
    setLogMessage('')
    if (String(planId).startsWith('local-')) {
      const fallback = fallbackWorkoutContent(profile.path)
      const chosen = fallback.plans.find((plan) => plan.id === planId) || fallback.plans[0]
      setSelectedPlan(chosen || null)
      setPlanDays(chosen?.id ? (fallback.byPlan[chosen.id] || []) : [])
      setSelectedDayId('')
      setActiveExerciseIndex(0)
      setDoneExerciseKeys(new Set())
      setSessionXp(0)
      setLogMessage(`Selected workout plan: ${chosen?.name || 'Fallback plan'}`)
      return
    }

    const { error: rpcError } = await supabase.rpc('select_workout_plan', { p_plan_id: planId })
    if (rpcError) {
      setError(rpcError.message)
      return
    }
    const chosen = plans.find((plan) => plan.id === planId)
    if (chosen?.name) {
      setLogMessage(`Selected workout plan: ${chosen.name}`)
    }
    setActiveExerciseIndex(0)
    setDoneExerciseKeys(new Set())
    setSessionXp(0)
    loadGymData()
  }

  const submitWorkoutLog = async ({ completedValue, notesOverride } = {}) => {
    setError('')

    const bonusXp = (bonusWalk45 ? 10 : 0) + (bonusRun45 ? 15 : 0)
    const finalCompleted = typeof completedValue === 'boolean' ? completedValue : completed
    const finalNotes = typeof notesOverride === 'string' ? notesOverride : exerciseNotes
    const payload = {
      notes: finalNotes,
      bonus_walk_45: bonusWalk45,
      bonus_run_45: bonusRun45,
      bonus_xp_expected: bonusXp,
      session_xp_frontend: sessionXp,
    }

    const beforeXp = Number(profile?.total_xp ?? profile?.xp_total ?? 0)
    const { data, error: rpcError } = await supabase.rpc('log_workout', {
      p_date: logDate,
      p_completed: finalCompleted,
      p_optional_payload: payload,
    })

    if (rpcError) {
      setError(rpcError.message)
      return
    }

    const result = Array.isArray(data) ? data[0] : data
    const awardedXp = Number(result?.awarded_xp ?? 0)
    if (awardedXp > 0) {
      onXpGain(awardedXp)
    } else if (completed && bonusXp > 0) {
      // Fallback for older DB functions that don't return awarded_xp payloads.
      onXpGain(bonusXp)
    }

    setExerciseNotes('')
    setBonusWalk45(false)
    setBonusRun45(false)
    setDoneExerciseKeys(new Set())
    setActiveExerciseIndex(0)
    setSessionXp(0)
    setLogMessage(
      `Workout logged${bonusXp > 0 ? ` with cardio bonus (+${bonusXp} XP)` : ''}.`,
    )
    let refreshedProfile = await onProfileRefresh()
    const afterXp = Number(refreshedProfile?.total_xp ?? refreshedProfile?.xp_total ?? 0)
    const expectedFallbackXp = awardedXp > 0 ? awardedXp : (finalCompleted ? sessionXp + bonusXp : bonusXp)
    if (expectedFallbackXp > 0 && afterXp <= beforeXp) {
      const persistRes = await incrementProfileXp(profile.id, expectedFallbackXp)
      if (persistRes.error) {
        setError(`Workout logged but XP persist failed: ${persistRes.error.message}`)
        return
      }
      refreshedProfile = await onProfileRefresh()
      const persistedXp = Number(refreshedProfile?.total_xp ?? refreshedProfile?.xp_total ?? 0)
      if (persistedXp <= beforeXp) {
        setError('Workout logged, but XP still did not change. Check profile update policy.')
        return
      }
    }
    loadGymData()
  }

  const onLogWorkout = async (event) => {
    event.preventDefault()
    await submitWorkoutLog()
  }

  const days = buildLast30Days(logs)
  const streak = calcStreaks(logs)
  const selectedDay = planDays.find((day) => day.id === selectedDayId) || planDays[0] || null
  const dayTemplate = selectedDay?.template || {}
  const dayExercises = Array.isArray(dayTemplate?.exercises)
    ? dayTemplate.exercises
    : Array.isArray(dayTemplate?.work)
      ? dayTemplate.work.map((item) => ({ name: String(item), meta: 'WORK BLOCK', sets: '-' }))
      : []
  const primaryMuscles = Array.isArray(dayTemplate?.muscles?.primary) ? dayTemplate.muscles.primary : []
  const secondaryMuscles = Array.isArray(dayTemplate?.muscles?.secondary) ? dayTemplate.muscles.secondary : []
  const totalDayXp = Number(dayTemplate?.xp || 0)
  const perExerciseXp = dayExercises.length > 0 ? Math.max(1, Math.floor(totalDayXp / dayExercises.length)) : 0
  const exerciseIcon = (exercise) => {
    const name = String(exercise?.name || '').toLowerCase()
    if (name.includes('treadmill') || name.includes('run') || name.includes('stair') || name.includes('walk')) return '🏃'
    if (name.includes('curl') || name.includes('tricep') || name.includes('press') || name.includes('row')) return '🏋️'
    if (name.includes('plank') || name.includes('crunch') || name.includes('woodchop')) return '🧱'
    return '⚔️'
  }
  const weekdayLabel = (day, index) => {
    const fromTitle = String(day?.title || '').split('•')[0].trim().toUpperCase()
    const lookup = {
      MON: 'Monday',
      TUE: 'Tuesday',
      WED: 'Wednesday',
      THU: 'Thursday',
      FRI: 'Friday',
      SAT: 'Saturday',
      SUN: 'Sunday',
    }
    return lookup[fromTitle] || ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][index] || `Day ${index + 1}`
  }
  const exerciseKey = (index) => `${selectedDay?.id || 'day'}:${index}`
  const onToggleExercise = (index) => {
    const key = exerciseKey(index)
    if (doneExerciseKeys.has(key)) return
    setDoneExerciseKeys((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    if (perExerciseXp > 0) {
      onXpGain(perExerciseXp)
      setSessionXp((prev) => prev + perExerciseXp)
    }
    if (index < dayExercises.length - 1) {
      setActiveExerciseIndex(index + 1)
    }
  }
  const completedCount = dayExercises.reduce((count, _exercise, index) => (doneExerciseKeys.has(exerciseKey(index)) ? count + 1 : count), 0)

  useEffect(() => {
    setDoneExerciseKeys(new Set())
    setActiveExerciseIndex(0)
    setSessionXp(0)
  }, [selectedDay?.id])

  return (
    <section className="tab-content active gym-s1-wrap">
      <div className="panel">
        <h3>{pathConfig.gymTitle}</h3>
        <p className="muted">{pathConfig.gymFlavor}</p>
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="panel">
        <h3>Workout Plans</h3>
        <div className="quest-list">
          {plans.map((plan) => (
            <article key={plan.id} className={cx('quest-item', 'gym-plan-card', selectedPlan?.id === plan.id && 'is-selected')}>
              <div>
                <strong>{plan.name}</strong>
                <p className="muted">{plan.description}</p>
              </div>
              <button
                type="button"
                className={cx('btn', selectedPlan?.id === plan.id ? 'btn-green' : 'btn-cyan')}
                onClick={() => onSelectPlan(plan.id)}
                disabled={selectedPlan?.id === plan.id}
              >
                {selectedPlan?.id === plan.id ? 'Selected' : 'Select Plan'}
              </button>
            </article>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>Plan Day Templates</h3>
        {selectedPlan ? <p className="muted">Current plan: {selectedPlan.name}</p> : <p className="muted">Select a plan first.</p>}
        <div className="gym-v4-day-bar">
          {planDays.map((day, index) => (
            <button
              key={day.id}
              type="button"
              className={cx('gym-v4-day-tab', selectedDay?.id === day.id && 'active')}
              onClick={() => {
                setSelectedDayId(day.id)
                setLogMessage(`Selected template: ${day.title}`)
              }}
            >
              {weekdayLabel(day, index)}
            </button>
          ))}
        </div>
        {selectedDay ? (
          <div className="gym-v4-session" style={{ marginTop: '10px' }}>
            <div className="gym-v4-hero">
              <div>
                <div className="gym-v4-session-tag">WORKOUT SESSION</div>
                <div className="gym-v4-session-name">{dayTemplate?.name || selectedDay.title}</div>
                <div className="gym-v4-session-sub">{dayTemplate?.subtitle || selectedDay.title}</div>
              </div>
              <div className="gym-v4-session-stats">
                <span>{dayTemplate?.duration || '~50 min'}</span>
                <strong>+{dayTemplate?.xp || 30} XP</strong>
                <span>Session: +{sessionXp} XP</span>
              </div>
            </div>

            <div className="gym-v4-muscles">
              <div>
                <div className="gym-v4-muscle-label">PRIMARY</div>
                <div className="gym-v4-muscle-tags">
                  {primaryMuscles.map((muscle) => <span key={muscle} className="gym-v4-muscle-tag primary">{muscle}</span>)}
                </div>
              </div>
              <div>
                <div className="gym-v4-muscle-label">SECONDARY</div>
                <div className="gym-v4-muscle-tags">
                  {secondaryMuscles.map((muscle) => <span key={muscle} className="gym-v4-muscle-tag secondary">{muscle}</span>)}
                </div>
              </div>
            </div>

            <div className="gym-v4-exercises">
              {dayExercises.map((exercise, index) => (
                <button
                  type="button"
                  key={`${exercise.name}-${index}`}
                  className={cx(
                    'gym-v4-exercise',
                    doneExerciseKeys.has(exerciseKey(index)) && 'done',
                    activeExerciseIndex === index && !doneExerciseKeys.has(exerciseKey(index)) && 'active',
                  )}
                  onClick={() => onToggleExercise(index)}
                >
                  <div className="gym-v4-exercise-num">{String(index + 1).padStart(2, '0')}</div>
                  <div className="gym-v4-exercise-icon">{exerciseIcon(exercise)}</div>
                  <div className="gym-v4-exercise-main">
                    <div className="gym-v4-exercise-name">{exercise.name}</div>
                    <div className="gym-v4-exercise-meta">{exercise.meta}</div>
                  </div>
                  <div className="gym-v4-exercise-sets">{exercise.sets}</div>
                </button>
              ))}
            </div>
            <div className="gym-v4-cta">
              <div className="gym-v4-progress-text">{completedCount}/{dayExercises.length} complete</div>
              <button
                type="button"
                className="gym-v4-complete-btn"
                onClick={async () => {
                  setCompleted(true)
                  const summary = `${dayTemplate?.name || selectedDay?.title}: ${completedCount}/${dayExercises.length} exercises complete.`
                  await submitWorkoutLog({ completedValue: true, notesOverride: summary })
                }}
              >
                COMPLETE WORKOUT
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <form className="panel form-stack gym-log-form" onSubmit={onLogWorkout}>
        <h3>Log Workout</h3>
        <label className="input-label">
          Date
          <input className="zbxp-input" type="date" value={logDate} onChange={(event) => setLogDate(event.target.value)} required />
        </label>

        <label className="input-label checkbox-row">
          <input type="checkbox" checked={completed} onChange={(event) => setCompleted(event.target.checked)} />
          Completed workout
        </label>

        <label className="input-label checkbox-row">
          <input type="checkbox" checked={bonusWalk45} onChange={(event) => setBonusWalk45(event.target.checked)} />
          Optional bonus: 45 minute walk (+10 XP)
        </label>

        <label className="input-label checkbox-row">
          <input type="checkbox" checked={bonusRun45} onChange={(event) => setBonusRun45(event.target.checked)} />
          Optional bonus: 45 minute run (+15 XP)
        </label>

        <label className="input-label">
          Exercises completed / notes (optional)
          <input
            className="zbxp-input"
            value={exerciseNotes}
            onChange={(event) => setExerciseNotes(event.target.value)}
            maxLength={220}
            placeholder="e.g., Push day done, added incline dumbbell press"
          />
        </label>

        <button type="submit" className="btn btn-green" style={{ width: '100%', padding: '14px' }}>Log Workout</button>
        {logMessage ? <p className="muted">{logMessage}</p> : null}
      </form>

      <div className="panel">
        <div className="row-between">
          <h3>30 Day Streak Grid</h3>
          <p className="muted">Current: {streak.current} • Longest: {streak.longest}</p>
        </div>
        <div className="streak-grid">
          {days.map((day) => (
            <span key={day.date} className={cx('streak-cell', `is-${day.status}`)} title={day.tooltip} />
          ))}
        </div>
      </div>
    </section>
  )
}

function ToolsPage() {
  const [activeTool, setActiveTool] = useState('planner')
  const [plannerItems, setPlannerItems] = useState([
    { time: '06:00', title: 'Morning routine', sub: '// hydration, prayer, prep', kind: 'study' },
    { time: '09:00', title: 'Deep work block', sub: '// coding + product execution', kind: 'business' },
    { time: '14:00', title: 'Sales outreach', sub: '// in-person restaurant visits', kind: 'business' },
    { time: '18:00', title: 'Gym session', sub: '// strength + cardio', kind: 'gym' },
  ])
  const [plannerTime, setPlannerTime] = useState('20:00')
  const [plannerInput, setPlannerInput] = useState('')
  const [journalWin, setJournalWin] = useState('')
  const [journalImprove, setJournalImprove] = useState('')
  const [journalEntries, setJournalEntries] = useState([])
  const [selectedJournalEntry, setSelectedJournalEntry] = useState(null)
  const [checkedHabits, setCheckedHabits] = useState([false, false, false, false])
  const [pagesRead, setPagesRead] = useState('')
  const [readingLogs, setReadingLogs] = useState([])
  const [weight, setWeight] = useState('')
  const [calories, setCalories] = useState('')
  const [nutritionLogs, setNutritionLogs] = useState([])
  const [goalText, setGoalText] = useState('')
  const [goalTimeframe, setGoalTimeframe] = useState('This Week')
  const [goalDueDate, setGoalDueDate] = useState('')
  const [goals, setGoals] = useState([])
  const [ticker, setTicker] = useState('')
  const [direction, setDirection] = useState('Long')
  const [trades, setTrades] = useState([])
  const [portfolioValue, setPortfolioValue] = useState('')
  const [portfolioSnapshots, setPortfolioSnapshots] = useState([])
  const [feedback, setFeedback] = useState('')
  const [nowTs, setNowTs] = useState(() => Date.now())
  const [pomodoroMode, setPomodoroMode] = useState('focus')
  const [customMinutes, setCustomMinutes] = useState(25)
  const [pomodoroTotal, setPomodoroTotal] = useState(25 * 60)
  const [pomodoroLeft, setPomodoroLeft] = useState(25 * 60)
  const [pomodoroRunning, setPomodoroRunning] = useState(false)

  const toolTabs = [
    { id: 'planner', label: '📅 Planner' },
    { id: 'journal', label: '📓 Journal' },
    { id: 'habits', label: '✅ Habits' },
    { id: 'pomodoro', label: '⏱ Focus' },
    { id: 'reading', label: '📚 Reading' },
    { id: 'nutrition', label: '🍽 Nutrition' },
    { id: 'goals', label: '🎯 Goals' },
    { id: 'trading', label: '📈 Trading' },
    { id: 'portfolio', label: '💹 Portfolio' },
  ]

  useEffect(() => {
    if (!pomodoroRunning) return undefined
    const interval = setInterval(() => {
      setPomodoroLeft((prev) => {
        if (prev <= 1) {
          setPomodoroRunning(false)
          setFeedback('Pomodoro complete.')
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [pomodoroRunning])

  useEffect(() => {
    const interval = setInterval(() => {
      setNowTs(Date.now())
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  const toggleHabit = (index) => {
    setCheckedHabits((prev) => prev.map((value, idx) => (idx === index ? !value : value)))
  }

  const applyPomodoroMode = (mode) => {
    const presets = { focus: 25, short: 5, long: 15 }
    const mins = presets[mode] || 25
    setPomodoroMode(mode)
    setPomodoroTotal(mins * 60)
    setPomodoroLeft(mins * 60)
    setPomodoroRunning(false)
  }

  const applyCustomPomodoro = () => {
    const mins = Math.max(1, Number(customMinutes || 25))
    setPomodoroMode('custom')
    setPomodoroTotal(mins * 60)
    setPomodoroLeft(mins * 60)
    setPomodoroRunning(false)
    setFeedback(`Pomodoro set to ${mins} minutes.`)
  }

  const formatClock = (seconds) => {
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  const formatPlannerTime = (timeText) => {
    const raw = String(timeText || '').trim()
    const match = raw.match(/^(\d{1,2}):(\d{2})$/)
    if (!match) return raw
    const hours = Number(match[1])
    const minutes = Number(match[2])
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return raw
    const date = new Date()
    date.setHours(hours, minutes, 0, 0)
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })
  }

  const addPlannerItem = () => {
    if (!plannerInput.trim()) return
    setPlannerItems((prev) => [
      ...prev,
      { time: plannerTime || '20:00', title: plannerInput.trim(), sub: '// custom block', kind: 'study' },
    ])
    setPlannerInput('')
    setPlannerTime('20:00')
    setFeedback('Planner block added.')
  }

  const saveJournal = () => {
    if (!journalWin.trim() && !journalImprove.trim()) return
    const entry = {
      id: Date.now(),
      date: new Date().toLocaleString(),
      win: journalWin.trim(),
      improve: journalImprove.trim(),
    }
    setJournalEntries((prev) => [entry, ...prev])
    setSelectedJournalEntry(entry)
    setJournalWin('')
    setJournalImprove('')
    setFeedback('Journal saved.')
  }

  const logReading = () => {
    const pages = Number(pagesRead)
    if (!pages) return
    setReadingLogs((prev) => [{ id: Date.now(), pages }, ...prev])
    setPagesRead('')
    setFeedback('Reading session logged.')
  }

  const logNutrition = () => {
    if (!weight && !calories) return
    setNutritionLogs((prev) => [{ id: Date.now(), weight, calories }, ...prev])
    setWeight('')
    setCalories('')
    setFeedback('Nutrition log saved.')
  }

  const addGoal = () => {
    if (!goalText.trim()) return
    let dueAt = null
    if (goalTimeframe === 'This Week') {
      dueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    } else if (goalTimeframe === 'This Month') {
      dueAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    } else if (goalTimeframe === 'This Year') {
      dueAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    } else if (goalTimeframe === 'Custom Date' && goalDueDate) {
      dueAt = new Date(`${goalDueDate}T23:59:59`).toISOString()
    }
    setGoals((prev) => [{ id: Date.now(), text: goalText.trim(), timeframe: goalTimeframe, dueAt }, ...prev])
    setGoalText('')
    setGoalDueDate('')
    setFeedback('Goal added.')
  }

  const formatCountdown = (dueAt) => {
    if (!dueAt) return 'No deadline'
    const diff = new Date(dueAt).getTime() - nowTs
    if (diff <= 0) return 'Expired'
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    const hours = Math.floor((diff / (1000 * 60 * 60)) % 24)
    return `${days}d ${hours}h left`
  }

  const logTrade = () => {
    if (!ticker.trim()) return
    setTrades((prev) => [{ id: Date.now(), ticker: ticker.trim().toUpperCase(), direction }, ...prev])
    setTicker('')
    setFeedback('Trade logged.')
  }

  const logPortfolio = () => {
    if (!portfolioValue) return
    setPortfolioSnapshots((prev) => [{ id: Date.now(), value: portfolioValue }, ...prev])
    setPortfolioValue('')
    setFeedback('Portfolio snapshot saved.')
  }

  return (
    <section className="tab-content active">
      <div className="tools-nav">
        {toolTabs.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={cx('tool-btn', activeTool === tool.id && 'active')}
            onClick={() => setActiveTool(tool.id)}
          >
            {tool.label}
          </button>
        ))}
      </div>

      <div className={cx('tool-content', activeTool === 'planner' && 'active')}>
        <div className="panel">
          <div className="panel-title">Daily Planner</div>
          <div className="panel-sub">// map your day with intention and execution blocks</div>
          <div className="planner-time-block" style={{ marginTop: '12px' }}>
            {plannerItems.map((item) => (
              <div key={`${item.time}-${item.title}`} className={cx('time-slot', 'filled', item.kind)}>
                <div className="time-slot-time">{formatPlannerTime(item.time)}</div>
                <div className="time-slot-content">
                  <div className="time-slot-title">{item.title}</div>
                  <div className="time-slot-sub">{item.sub}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="actions" style={{ marginTop: '10px' }}>
            <input
              className="zbxp-input planner-time-input"
              type="time"
              value={plannerTime}
              onChange={(event) => setPlannerTime(event.target.value)}
              aria-label="Planner block time"
            />
            <input
              className="zbxp-input"
              value={plannerInput}
              onChange={(event) => setPlannerInput(event.target.value)}
              placeholder="Add a custom planner block"
            />
            <button type="button" className="btn btn-cyan" onClick={addPlannerItem}>Add Block</button>
          </div>
        </div>
      </div>

      <div className={cx('tool-content', activeTool === 'journal' && 'active')}>
        <div className="panel">
          <div className="panel-title">Journal</div>
          <div className="panel-sub">// log wins, lessons, and tomorrow's improvement target</div>
          <div className="form-stack" style={{ marginTop: '12px' }}>
            <div>
              <label className="input-label">WHAT DID YOU ACCOMPLISH TODAY?</label>
              <textarea className="zbxp-textarea" placeholder="// log your wins and lessons..." value={journalWin} onChange={(event) => setJournalWin(event.target.value)} />
            </div>
            <div>
              <label className="input-label">WHAT WILL YOU IMPROVE TOMORROW?</label>
              <textarea className="zbxp-textarea" style={{ minHeight: '70px' }} placeholder="// one improvement..." value={journalImprove} onChange={(event) => setJournalImprove(event.target.value)} />
            </div>
            <button type="button" className="btn btn-purple btn-full" onClick={saveJournal}>SAVE JOURNAL</button>
            <ul className="clean-list">
              {journalEntries.slice(0, 3).map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className={cx('history-item', 'journal-entry-btn', selectedJournalEntry?.id === entry.id && 'is-selected')}
                    onClick={() => setSelectedJournalEntry(entry)}
                  >
                    <strong>{entry.date}</strong>
                    <span className="muted">{entry.win || 'No win text'}</span>
                    <span className="muted">Click to open full entry</span>
                  </button>
                </li>
              ))}
            </ul>
            {selectedJournalEntry ? (
              <div className="journal-pop">
                <div className="row-between">
                  <strong>Journal Entry</strong>
                  <button type="button" className="btn btn-red" onClick={() => setSelectedJournalEntry(null)}>Close</button>
                </div>
                <p className="muted">{selectedJournalEntry.date}</p>
                <div className="journal-pop-block">
                  <div className="input-label">WHAT YOU ACCOMPLISHED</div>
                  <p>{selectedJournalEntry.win || 'No win logged.'}</p>
                </div>
                <div className="journal-pop-block">
                  <div className="input-label">WHAT TO IMPROVE TOMORROW</div>
                  <p>{selectedJournalEntry.improve || 'No improvement logged.'}</p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className={cx('tool-content', activeTool === 'habits' && 'active')}>
        <div className="panel">
          <div className="panel-title">Habit Tracker</div>
          <div className="panel-sub">// compounding consistency checklist</div>
          <div className="habit-grid">
            {[
              ['💧', 'Hydration target', 'Daily baseline'],
              ['📖', 'Read 30 pages', 'Growth protocol'],
              ['🏋️', 'Workout complete', 'Body system'],
              ['📝', 'Night journal', 'Reflection system'],
            ].map(([icon, name, streak], idx) => (
              <button key={name} type="button" className="habit-row" onClick={() => toggleHabit(idx)}>
                <div className="habit-icon">{icon}</div>
                <div className="habit-info">
                  <div className="habit-name">{name}</div>
                  <div className="habit-streak">{streak}</div>
                </div>
                <div className={cx('habit-check', checkedHabits[idx] && 'checked')}>{checkedHabits[idx] ? '✓' : ''}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={cx('tool-content', activeTool === 'pomodoro' && 'active')}>
        <div className="panel">
          <div className="panel-title">Focus Timer</div>
          <div className="panel-sub">// lock into focused execution sessions</div>
          <div style={{ marginTop: '12px', display: 'grid', gap: '10px' }}>
            <div className="actions">
              <button type="button" className={cx('tool-btn', pomodoroMode === 'focus' && 'active')} onClick={() => applyPomodoroMode('focus')}>FOCUS 25m</button>
              <button type="button" className={cx('tool-btn', pomodoroMode === 'short' && 'active')} onClick={() => applyPomodoroMode('short')}>SHORT 5m</button>
              <button type="button" className={cx('tool-btn', pomodoroMode === 'long' && 'active')} onClick={() => applyPomodoroMode('long')}>LONG 15m</button>
            </div>
            <div className="challenge-card">
              <div className="challenge-title" style={{ fontSize: '28px', textAlign: 'center' }}>{formatClock(pomodoroLeft)}</div>
              <div className="panel-sub" style={{ textAlign: 'center' }}>FOCUS SESSION - STAY LOCKED IN</div>
            </div>
            <div className="actions">
              <button type="button" className="btn btn-cyan" onClick={() => setPomodoroRunning((prev) => !prev)}>
                {pomodoroRunning ? 'Pause' : 'Start'}
              </button>
              <button type="button" className="btn btn-red" onClick={() => { setPomodoroRunning(false); setPomodoroLeft(pomodoroTotal) }}>
                Reset
              </button>
            </div>
            <div className="actions">
              <input
                className="zbxp-input"
                type="number"
                min="1"
                max="180"
                value={customMinutes}
                onChange={(event) => setCustomMinutes(event.target.value)}
                placeholder="Custom minutes"
              />
              <button type="button" className="btn btn-green" onClick={applyCustomPomodoro}>Apply Minutes</button>
            </div>
          </div>
        </div>
      </div>

      <div className={cx('tool-content', activeTool === 'reading' && 'active')}>
        <div className="panel">
          <div className="panel-title">Reading Tracker</div>
          <div className="panel-sub readable-copy">// reading momentum and knowledge compounding</div>
          <div className="form-stack" style={{ marginTop: '12px' }}>
            <div>
              <label className="input-label">PAGES READ TODAY</label>
              <input className="zbxp-input" type="number" placeholder="30" value={pagesRead} onChange={(event) => setPagesRead(event.target.value)} />
            </div>
            <button type="button" className="btn btn-cyan btn-full" onClick={logReading}>LOG READING SESSION</button>
            <p className="muted">Sessions logged: {readingLogs.length}</p>
            <ul className="clean-list">
              {readingLogs.slice(0, 3).map((entry) => (
                <li key={entry.id} className="history-item">{entry.pages} pages</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className={cx('tool-content', activeTool === 'nutrition' && 'active')}>
        <div className="panel">
          <div className="panel-title">Nutrition Log</div>
          <div className="panel-sub">// calories, protein, hydration tracking</div>
          <div className="form-stack" style={{ marginTop: '12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: '10px' }}>
              <div>
                <label className="input-label">WEIGHT (LBS)</label>
                <input className="zbxp-input" type="number" placeholder="195" value={weight} onChange={(event) => setWeight(event.target.value)} />
              </div>
              <div>
                <label className="input-label">CALORIES</label>
                <input className="zbxp-input" type="number" placeholder="2000" value={calories} onChange={(event) => setCalories(event.target.value)} />
              </div>
            </div>
            <button type="button" className="btn btn-green btn-full" onClick={logNutrition}>LOG NUTRITION</button>
            <p className="muted">Entries logged: {nutritionLogs.length}</p>
            <ul className="clean-list">
              {nutritionLogs.slice(0, 3).map((entry) => (
                <li key={entry.id} className="history-item">Weight: {entry.weight || '-'} | Calories: {entry.calories || '-'}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className={cx('tool-content', activeTool === 'goals' && 'active')}>
        <div className="panel">
          <div className="panel-title">Goals</div>
          <div className="panel-sub">// define and track execution outcomes</div>
          <div className="form-stack" style={{ marginTop: '12px' }}>
            <div>
              <label className="input-label">NEW GOAL</label>
              <input className="zbxp-input" type="text" placeholder="What do you want to achieve?" value={goalText} onChange={(event) => setGoalText(event.target.value)} />
            </div>
            <div>
              <label className="input-label">TIMEFRAME</label>
              <select className="zbxp-select" value={goalTimeframe} onChange={(event) => setGoalTimeframe(event.target.value)}>
                <option>This Week</option>
                <option>This Month</option>
                <option>This Year</option>
                <option>Custom Date</option>
              </select>
            </div>
            {goalTimeframe === 'Custom Date' ? (
              <div>
                <label className="input-label">DUE DATE</label>
                <input className="zbxp-input" type="date" value={goalDueDate} onChange={(event) => setGoalDueDate(event.target.value)} />
              </div>
            ) : null}
            <button type="button" className="btn btn-gold btn-full" onClick={addGoal}>ADD GOAL</button>
            <ul className="clean-list">
              {goals.slice(0, 3).map((goal) => (
                <li key={goal.id} className="history-item">
                  <strong>{goal.text}</strong>
                  <span className="muted">{goal.timeframe}</span>
                  <span className="muted">{formatCountdown(goal.dueAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className={cx('tool-content', activeTool === 'trading' && 'active')}>
        <div className="panel">
          <div className="panel-title">Trading Journal</div>
          <div className="panel-sub">// decision quality and P&L review</div>
          <div className="form-stack" style={{ marginTop: '12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: '10px' }}>
              <div>
                <label className="input-label">TICKER</label>
                <input className="zbxp-input" type="text" placeholder="NVDA" value={ticker} onChange={(event) => setTicker(event.target.value)} />
              </div>
              <div>
                <label className="input-label">DIRECTION</label>
                <select className="zbxp-select" value={direction} onChange={(event) => setDirection(event.target.value)}>
                  <option>Long</option>
                  <option>Short</option>
                </select>
              </div>
            </div>
            <button type="button" className="btn btn-green btn-full" onClick={logTrade}>LOG TRADE</button>
            <p className="muted">Trades logged: {trades.length}</p>
            <ul className="clean-list">
              {trades.slice(0, 3).map((trade) => (
                <li key={trade.id} className="history-item">{trade.ticker} • {trade.direction}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className={cx('tool-content', activeTool === 'portfolio' && 'active')}>
        <div className="panel">
          <div className="panel-title">Portfolio Snapshot</div>
          <div className="panel-sub">// weekly value tracking and notes</div>
          <div className="form-stack" style={{ marginTop: '12px' }}>
            <div>
              <label className="input-label">PORTFOLIO VALUE ($)</label>
              <input className="zbxp-input" type="number" placeholder="12450" value={portfolioValue} onChange={(event) => setPortfolioValue(event.target.value)} />
            </div>
            <button type="button" className="btn btn-green btn-full" onClick={logPortfolio}>LOG WEEKLY SNAPSHOT</button>
            <p className="muted">Snapshots logged: {portfolioSnapshots.length}</p>
            <ul className="clean-list">
              {portfolioSnapshots.slice(0, 3).map((snap) => (
                <li key={snap.id} className="history-item">${snap.value}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      {feedback ? <p className="muted">{feedback}</p> : null}
    </section>
  )
}

function StatTile({ label, value }) {
  const prevRef = useRef(value)
  const [delta, setDelta] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)

  useEffect(() => {
    const diff = Number(value) - Number(prevRef.current)
    if (diff > 0) {
      setDelta(diff)
      setIsAnimating(true)
      const timeout = setTimeout(() => {
        setIsAnimating(false)
        setDelta(0)
      }, 900)
      prevRef.current = value
      return () => clearTimeout(timeout)
    }

    prevRef.current = value
    return undefined
  }, [value])

  return (
    <article className={cx('stat-box', isAnimating && 'is-up')}>
      <span className="stat-box-label">{label}</span>
      <div className="stat-box-val">{value}</div>
      {isAnimating ? <span className="stat-up">↑ +{delta}</span> : null}
    </article>
  )
}

function StatsPage() {
  const { profile } = useApp()
  const [categoryStats, setCategoryStats] = useState({
    study: 0,
    coding: 0,
    gym: 0,
    business: 0,
  })
  const [weeklyXP, setWeeklyXP] = useState(0)
  const [allTimeXP, setAllTimeXP] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    const loadStats = async () => {
      const [completionRes, xpRes] = await Promise.all([
        supabase
          .from('quest_completions')
          .select(`
            id,
            user_active_quests (
              id,
              status,
              selected_at,
              quests (
                id,
                title,
                xp_reward,
                category,
                difficulty
              )
            )
          `)
          .eq('user_id', profile.id),
        supabase
          .from('xp_events')
          .select('amount, created_at')
          .eq('user_id', profile.id),
      ])

      if (completionRes.error || xpRes.error) {
        setError(completionRes.error?.message || xpRes.error?.message || 'Stats load failed')
        return
      }

      const nextCategory = {
        study: 0,
        coding: 0,
        gym: 0,
        business: 0,
      }

      for (const row of completionRes.data || []) {
        const activeQuest = Array.isArray(row.user_active_quests) ? row.user_active_quests[0] : row.user_active_quests
        const quest = Array.isArray(activeQuest?.quests) ? activeQuest.quests[0] : activeQuest?.quests
        const category = String(quest?.category || '').toLowerCase()
        if (Object.prototype.hasOwnProperty.call(nextCategory, category)) {
          nextCategory[category] += 1
        }
      }

      const weekStart = new Date()
      const day = weekStart.getDay()
      const diffToMonday = (day + 6) % 7
      weekStart.setHours(0, 0, 0, 0)
      weekStart.setDate(weekStart.getDate() - diffToMonday)

      let weekly = 0
      let total = 0
      for (const event of xpRes.data || []) {
        const amount = Number(event.amount || 0)
        total += amount
        if (new Date(event.created_at) >= weekStart) {
          weekly += amount
        }
      }

      setCategoryStats(nextCategory)
      setWeeklyXP(weekly)
      setAllTimeXP(total)
    }

    loadStats()
  }, [profile.id])

  const profileXp = getProfileXp(profile)
  const level = levelFromXp(profileXp)
  const xpProgress = profileXp % 100

  return (
    <section className="tab-content active">
      {error ? <p className="error-text">{error}</p> : null}
      <div className="panel">
        <h3>Stats Core</h3>
        <p className="muted">Progress metrics with responsive stat-up indicators.</p>
      </div>

      <div className="stat-grid">
        <StatTile label="Level" value={level} />
        <StatTile label="Total XP" value={profileXp} />
        <StatTile label="Weekly XP" value={weeklyXP} />
        <StatTile label="All-Time XP (events)" value={allTimeXP} />
      </div>

      <div className="panel">
        <div className="row-between">
          <h3>XP Progress</h3>
          <span className="muted">{xpProgress}/100</span>
        </div>
        <div className="xp-track">
          <span className="xp-fill" style={{ width: `${xpProgress}%` }} />
        </div>
      </div>

      <div className="stat-grid">
        <StatTile label="Study Quests" value={categoryStats.study} />
        <StatTile label="Coding Quests" value={categoryStats.coding} />
        <StatTile label="Gym Quests" value={categoryStats.gym} />
        <StatTile label="Business Quests" value={categoryStats.business} />
      </div>
    </section>
  )
}

function LeaderboardPage() {
  const { profile } = useApp()
  const [groups, setGroups] = useState([])
  const [allGroups, setAllGroups] = useState([])
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [timeframe, setTimeframe] = useState('weekly')
  const [board, setBoard] = useState([])
  const [globalBoard, setGlobalBoard] = useState([])
  const [uiMessage, setUiMessage] = useState('')
  const [error, setError] = useState('')
  const [joinPromptGroup, setJoinPromptGroup] = useState(null)

  const loadGroups = async () => {
    setError('')
    const { data, error: groupsError } = await supabase
      .from('group_members')
      .select('group_id, role, group:groups(id, name, created_by)')
      .eq('user_id', profile.id)

    if (groupsError) {
      setError(groupsError.message)
      return
    }

    const nextGroups = (data || []).map((row) => row.group).filter(Boolean)
    setGroups(nextGroups)

    if (!selectedGroupId && nextGroups.length > 0) {
      setSelectedGroupId(nextGroups[0].id)
    }
  }

  const loadBoard = async () => {
    if (!selectedGroupId) {
      setBoard([])
      return
    }

    const boardRes = await supabase.rpc('get_leaderboard', {
      p_group_id: selectedGroupId,
      p_timeframe: timeframe,
    })

    if (boardRes.error) {
      setError(boardRes.error?.message || 'Leaderboard load failed')
      return
    }

    const hydrated = await hydrateRowsWithProfileNames(boardRes.data || [])
    setBoard(hydrated)
  }

  const loadAllGroups = async () => {
    const { data, error: allGroupsError } = await supabase
      .from('groups')
      .select('id, name, created_by, invite_code')
      .order('name', { ascending: true })

    if (allGroupsError) {
      setError((prev) => prev || allGroupsError.message)
      return
    }
    setAllGroups(data || [])
  }

  const loadGlobalBoard = async () => {
    let res = await supabase
      .from('profiles')
      .select('id, username, display_name, total_xp')
      .order('total_xp', { ascending: false })
      .limit(25)

    if (res.error && String(res.error.message || '').toLowerCase().includes('total_xp')) {
      res = await supabase
        .from('profiles')
        .select('id, username, display_name, xp_total')
        .order('xp_total', { ascending: false })
        .limit(25)
    }

    if (res.error) {
      setError((prev) => prev || res.error.message)
      return
    }

    const normalized = (res.data || []).map((row) => ({
      user_id: row.id,
      username: row.display_name || row.username,
      xp_total: Number(row.total_xp ?? row.xp_total ?? 0),
    }))
    const hydrated = await hydrateRowsWithProfileNames(normalized)
    setGlobalBoard(hydrated)
  }

  const onJoinGroupFromDirectory = async (group) => {
    if (!group?.id) return
    setError('')
    setUiMessage('')

    if (!group.invite_code) {
      setError('Join failed: this guild has no invite code. Ask guild owner for a code.')
      return
    }

    const joinRes = await supabase.rpc('join_guild_by_code', {
      p_code: String(group.invite_code).toUpperCase(),
    })

    if (joinRes.error) {
      setError(`Join failed: ${joinRes.error.message}`)
      return
    }

    setUiMessage(`Joined ${group.name}.`)
    setJoinPromptGroup(null)
    await loadGroups()
    setSelectedGroupId(group.id)
    await loadBoard()
  }

  useEffect(() => {
    loadGroups()
    loadAllGroups()
    loadGlobalBoard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id])

  useEffect(() => {
    loadBoard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId, timeframe])

  return (
    <section className="tab-content active leaderboard-s1-wrap">
      {error ? <p className="error-text">{error}</p> : null}
      {uiMessage ? <p className="muted">{uiMessage}</p> : null}

      <div className="panel">
        <h3>My Groups</h3>
        <div className="actions" style={{ marginBottom: '8px' }}>
          <button type="button" className="btn btn-cyan" onClick={loadGroups}>Refresh My Groups</button>
        </div>
        <div className="actions">
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className={cx('history-item', 'guild-row-btn', 'guild-v4-row', selectedGroupId === group.id && 'is-selected')}
              onClick={() => {
                setSelectedGroupId(group.id)
                setUiMessage(`Selected group: ${group.name}`)
              }}
            >
              <strong>{group.name}</strong>
              <span className="muted">Member group • click to load board</span>
            </button>
          ))}
        </div>
        {groups.length === 0 ? <p className="muted">No groups found here yet. Create or join one in Guild tab first.</p> : null}
      </div>

      <div className="panel">
        <h3>World Guild Directory</h3>
        <p className="muted">// browse and select any guild board</p>
        <div className="actions" style={{ marginBottom: '8px' }}>
          <button type="button" className="btn btn-cyan" onClick={loadAllGroups}>Refresh World Guilds</button>
        </div>
        <div className="actions">
          {allGroups.map((group) => {
            const isMember = groups.some((entry) => entry.id === group.id)
            return (
              <button
                key={group.id}
                type="button"
                className={cx('history-item', 'guild-row-btn', 'guild-v4-row', selectedGroupId === group.id && 'is-selected')}
                onClick={() => {
                  setSelectedGroupId(group.id)
                  setJoinPromptGroup(group)
                  setUiMessage(
                    isMember
                      ? `Selected group: ${group.name}`
                      : `Previewing ${group.name}. Member-only actions may be restricted.`,
                  )
                }}
              >
                <strong>{group.name}</strong>
                <span className="muted">{isMember ? 'Member view' : 'Preview view'}</span>
              </button>
            )
          })}
        </div>
        {allGroups.length === 0 ? <p className="muted">No guild directory rows visible yet.</p> : null}
        {joinPromptGroup && !groups.some((entry) => entry.id === joinPromptGroup.id) ? (
          <div className="challenge-card" style={{ marginTop: '10px' }}>
            <div className="challenge-title">Join {joinPromptGroup.name}?</div>
            <div className="panel-sub">Join this guild to compete on member boards.</div>
            <div className="actions" style={{ marginTop: '8px' }}>
              <button type="button" className="btn btn-green" onClick={() => onJoinGroupFromDirectory(joinPromptGroup)}>
                Join Guild
              </button>
              <button type="button" className="btn btn-red" onClick={() => setJoinPromptGroup(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="panel">
        <div className="row-between">
          <h3>Leaderboard</h3>
          <div className="actions">
            <button
              type="button"
              className={cx('btn', timeframe === 'weekly' ? 'btn-cyan' : 'btn-green')}
              onClick={() => {
                setTimeframe('weekly')
                setUiMessage('Viewing weekly leaderboard')
              }}
            >
              Weekly
            </button>
            <button
              type="button"
              className={cx('btn', timeframe === 'all_time' ? 'btn-cyan' : 'btn-green')}
              onClick={() => {
                setTimeframe('all_time')
                setUiMessage('Viewing all-time leaderboard')
              }}
            >
              All-Time
            </button>
          </div>
        </div>
        <ul className="clean-list">
          {board.map((row) => (
            <li key={row.user_id} className="history-item leaderboard-v4-row">
              <strong>{safeDisplayName(row)}</strong>
              <span>{row.xp_total ?? row.xp ?? 0} XP</span>
            </li>
          ))}
        </ul>
        {board.length === 0 ? <p className="muted">No leaderboard rows yet for this group/timeframe.</p> : null}
      </div>

      <div className="panel">
        <div className="row-between">
          <h3>Global Leaderboard</h3>
          <button type="button" className="btn btn-cyan" onClick={loadGlobalBoard}>Refresh Global</button>
        </div>
        <ul className="clean-list">
          {globalBoard.map((row, index) => (
            <li key={row.user_id} className="history-item leaderboard-v4-row">
              <strong>#{index + 1} {safeDisplayName(row)}</strong>
              <span>{row.xp_total ?? 0} XP</span>
            </li>
          ))}
        </ul>
        {globalBoard.length === 0 ? <p className="muted">No global leaderboard rows visible yet.</p> : null}
      </div>
    </section>
  )
}

function AIPage() {
  return (
    <section className="tab-content active">
      <div className="panel">
        <div className="panel-title">AI Quest Generator</div>
        <div className="panel-sub">// beta stub: personalized daily quests will be generated from your profile, streaks, and priorities</div>
        <div className="challenge-card" style={{ marginTop: '12px' }}>
          <div className="challenge-title">Coming in next build</div>
          <div className="panel-sub">This tab is now clickable and route-ready for the next integration pass.</div>
        </div>
      </div>
    </section>
  )
}

function AppShell({ onSignOut, onProfileRefresh, statPulse, onClearXpPulse, onXpGain, weeklyXP }) {
  const { pathConfig, profile } = useApp()
  const iosSafariInstallable = useMemo(() => {
    if (typeof window === 'undefined') return false
    const ua = window.navigator.userAgent.toLowerCase()
    const isIos = /iphone|ipad|ipod/.test(ua)
    const isSafari = /safari/.test(ua) && !/crios|fxios|edgios/.test(ua)
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
    return Boolean(isIos && isSafari && !isStandalone)
  }, [])
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState(null)
  const [isInstallEligible, setIsInstallEligible] = useState(false)
  const [showIosInstallHelp, setShowIosInstallHelp] = useState(false)

  useEffect(() => {
    if (!statPulse) return
    const timeout = setTimeout(() => onClearXpPulse(), 1000)
    return () => clearTimeout(timeout)
  }, [statPulse, onClearXpPulse])

  useEffect(() => {
    const onBeforeInstallPrompt = (event) => {
      event.preventDefault()
      setDeferredInstallPrompt(event)
      setIsInstallEligible(true)
    }

    const onInstalled = () => {
      setDeferredInstallPrompt(null)
      setIsInstallEligible(false)
      setShowIosInstallHelp(false)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const onInstallClick = async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt()
      const result = await deferredInstallPrompt.userChoice
      if (result?.outcome) {
        setIsInstallEligible(false)
      }
      setDeferredInstallPrompt(null)
      return
    }
    if (iosSafariInstallable) {
      setShowIosInstallHelp(true)
    }
  }

  return (
    <div className="sl-hud">
      <div className="scanlines" />
      <div className="app" style={{ '--path-accent': pathConfig.accent, '--path-accent-soft': pathConfig.accentSoft }}>
        <header className="topbar">
          <div className="logo-group">
            <div className="logo">ZBXP</div>
            <div className="logo-sub">// HUNTER SYSTEM v4.0</div>
          </div>
          <div className="topbar-right">
            <div className="system-status">
              <span className="status-dot" />
              {pathConfig.shellTitle || 'SYSTEM ONLINE'}
            </div>
            {(isInstallEligible || iosSafariInstallable) ? (
              <button type="button" className="btn btn-cyan" onClick={onInstallClick}>
                Install
              </button>
            ) : null}
            <button type="button" className="btn btn-red" onClick={onSignOut}>Sign Out</button>
          </div>
        </header>

        {showIosInstallHelp ? (
          <div className="panel install-help-panel">
            <div className="panel-title">Install On iPhone</div>
            <div className="panel-sub">Safari {'->'} Share icon {'->'} Add to Home Screen</div>
            <button type="button" className="btn btn-cyan" onClick={() => setShowIosInstallHelp(false)}>Close</button>
          </div>
        ) : null}

        <ProfileHUD profile={profile} weeklyXP={weeklyXP} statPulse={statPulse} />

        <nav className="nav" aria-label="Primary navigation">
          <NavLink to="/dashboard" className={({ isActive }) => cx('nav-btn', isActive && 'active')}>
            Dashboard
          </NavLink>
          <NavLink to="/quests" className={({ isActive }) => cx('nav-btn', isActive && 'active')}>
            Quests
          </NavLink>
          <NavLink to="/boss" className={({ isActive }) => cx('nav-btn', isActive && 'active')}>
            Boss Fight
          </NavLink>
          <NavLink to="/skills" className={({ isActive }) => cx('nav-btn', isActive && 'active')}>
            Skill Tree
          </NavLink>
          <NavLink to="/guild" className={({ isActive }) => cx('nav-btn', isActive && 'active')}>
            Guild
          </NavLink>
          <NavLink to="/gym" className={({ isActive }) => cx('nav-btn', isActive && 'active')}>
            Gym
          </NavLink>
          <NavLink to="/stats" className={({ isActive }) => cx('nav-btn', isActive && 'active')}>
            Stats
          </NavLink>
          <NavLink to="/leaderboard" className={({ isActive }) => cx('nav-btn', isActive && 'active')}>
            Ranks
          </NavLink>
          <NavLink to="/tools" className={({ isActive }) => cx('nav-btn', 'tools-btn', isActive && 'active')}>
            ⚙ Tools
          </NavLink>
          <NavLink to="/ai" className={({ isActive }) => cx('nav-btn', 'ai-nav-btn', isActive && 'active')}>
            🤖 Coming Soon
          </NavLink>
        </nav>

        <main className="tab-content active">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage onProfileRefresh={onProfileRefresh} onXpGain={onXpGain} />} />
            <Route path="/quests" element={<QuestsPage onProfileRefresh={onProfileRefresh} onXpGain={onXpGain} />} />
            <Route path="/boss" element={<BossFightPage />} />
            <Route path="/skills" element={<SkillTreePage />} />
            <Route path="/guild" element={<GuildPage />} />
            <Route path="/gym" element={<GymPage onProfileRefresh={onProfileRefresh} onXpGain={onXpGain} />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/ai" element={<AIPage />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [isBooting, setIsBooting] = useState(true)
  const [profileError, setProfileError] = useState('')
  const [bootError, setBootError] = useState('')
  const [bootWarning, setBootWarning] = useState('')
  const [profilePendingSince, setProfilePendingSince] = useState(0)
  const [xpPulse, setXpPulse] = useState(0)
  const perksState = usePerks(session?.user?.id || null)

  const fetchProfile = async (user) => {
    const attempts = [
      { timeoutMs: 20000, backoffMs: 400 },
      { timeoutMs: 20000, backoffMs: 800 },
      { timeoutMs: 20000, backoffMs: 1200 },
    ]
    let lastError = null

    for (let i = 0; i < attempts.length; i += 1) {
      const { timeoutMs, backoffMs } = attempts[i]
      try {
        console.info('[bootstrap.profile] attempt', i + 1, 'timeout', timeoutMs)
        const nextProfile = await withTimeout(ensureProfile(user), timeoutMs, 'Profile load attempt timed out.')
        const normalizedProfile = {
          ...nextProfile,
          username: safeDisplayName(nextProfile, user.id),
          total_xp: Number(nextProfile?.total_xp ?? nextProfile?.xp_total ?? 0),
          current_streak: Number(nextProfile?.current_streak ?? 0),
          longest_streak: Number(nextProfile?.longest_streak ?? 0),
        }
        setProfile(normalizedProfile)
        setProfileError('')
        setBootError('')
        console.info('[bootstrap.profile] success on attempt', i + 1)
        return normalizedProfile
      } catch (error) {
        lastError = error
        console.warn('[bootstrap.profile] attempt failed', i + 1, String(error?.message || error))
        if (i < attempts.length - 1 && backoffMs > 0) {
          await sleep(backoffMs)
        }
      }
    }

    try {
      const fallbackProfile = await supabase
        .from('profiles')
        .select('id, username, player_class, path, total_xp, xp_total, current_streak, longest_streak')
        .eq('id', user.id)
        .maybeSingle()
      if (!fallbackProfile.error && fallbackProfile.data) {
        const normalizedProfile = {
          ...fallbackProfile.data,
          username: safeDisplayName(fallbackProfile.data, user.id),
          total_xp: Number(fallbackProfile.data?.total_xp ?? fallbackProfile.data?.xp_total ?? 0),
          current_streak: Number(fallbackProfile.data?.current_streak ?? 0),
          longest_streak: Number(fallbackProfile.data?.longest_streak ?? 0),
        }
        setProfile(normalizedProfile)
        setProfileError('')
        setBootError('')
        console.info('[bootstrap.profile] recovered via fallback select')
        return normalizedProfile
      }
      if (fallbackProfile.error) {
        lastError = fallbackProfile.error
      }
    } catch (fallbackError) {
      lastError = fallbackError
    }

    try {
      const minimalFallback = await supabase
        .from('profiles')
        .select('id, username, player_class')
        .eq('id', user.id)
        .maybeSingle()
      if (!minimalFallback.error && minimalFallback.data) {
        const normalizedProfile = {
          ...minimalFallback.data,
          username: safeDisplayName(minimalFallback.data, user.id),
          total_xp: 0,
          current_streak: 0,
          longest_streak: 0,
        }
        setProfile(normalizedProfile)
        setProfileError('')
        setBootError('')
        console.info('[bootstrap.profile] recovered via minimal fallback')
        return normalizedProfile
      }
      if (minimalFallback.error) {
        lastError = minimalFallback.error
      }
    } catch (minimalError) {
      lastError = minimalError
    }

    const message = lastError?.message || 'Failed to load profile'
    if (isAuthLockTimeoutError(message)) {
      setBootWarning('Session lock contention detected. Continuing bootstrap without exclusive lock.')
      setProfileError('Profile load delayed by lock contention. Tap Retry Profile Load.')
      return null
    }
    setProfileError(message)
    return null
  }

  useEffect(() => {
    let isActive = true
    let timeoutId

    if (!supabase) {
      setIsBooting(false)
      setSession(null)
      return () => {
        isActive = false
      }
    }

    const boot = async () => {
      try {
        const lockState = await tryAcquireBootLock()
        if (isActive && !lockState.acquired) {
          setBootWarning('Another tab is booting. Continuing here without waiting for lock.')
        }

        let sessionData = null
        let lastAuthError = null
        const authAttempts = [20000, 20000, 20000]
        for (let i = 0; i < authAttempts.length; i += 1) {
          try {
            const { data, error } = await withTimeout(
              supabase.auth.getSession(),
              authAttempts[i],
              'Auth session restore timed out.',
            )
            if (error) throw error
            sessionData = data
            lastAuthError = null
            break
          } catch (error) {
            lastAuthError = error
            console.warn('[bootstrap.auth] getSession attempt failed', i + 1, String(error?.message || error))
            if (i < authAttempts.length - 1) {
              await sleep(400 * (i + 1))
            }
          }
        }

        if (!isActive) return

        if (lastAuthError) {
          const authMessage = lastAuthError?.message || 'Failed to restore session'
          if (isAuthLockTimeoutError(lastAuthError)) {
            setBootWarning('Session lock contention detected. Could not restore instantly; continuing without lock.')
          } else {
            setBootError(authMessage)
          }
          setSession(null)
          setProfile(null)
          return
        }

        setBootError('')
        if (sessionData.session && !sessionData.session.user) {
          setSession(null)
          setProfile(null)
          setProfileError('Session is missing user identity. Please sign in again.')
          return
        }
        setSession(sessionData.session)
        if (sessionData.session?.user) {
          await fetchProfile(sessionData.session.user)
        }
      } catch (error) {
        if (!isActive) return
        if (isAuthLockTimeoutError(error)) {
          setBootWarning('Session lock contention detected. Continuing without exclusive lock.')
          return
        }
        setBootError(error?.message || 'Unexpected auth bootstrap error')
      } finally {
        if (isActive) {
          setIsBooting(false)
        }
      }
    }

    boot()

    timeoutId = setTimeout(() => {
      if (!isActive) return
      setBootError((prev) => prev || 'Auth bootstrap timed out. Use Retry Profile Load or sign in again.')
      setIsBooting(false)
    }, 30000)

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      try {
        if (nextSession && !nextSession.user) {
          setSession(null)
          setProfile(null)
          setProfileError('Session became invalid (missing user identity). Please sign in again.')
          return
        }
        setSession(nextSession)
        if (nextSession?.user) {
          await fetchProfile(nextSession.user)
        } else {
          setProfile(null)
          setProfileError('')
        }
      } catch (error) {
        if (isAuthLockTimeoutError(error)) {
          setBootWarning('Session lock contention detected. Keeping current session state.')
          return
        }
        setBootError(error?.message || 'Failed to update auth state')
      } finally {
        setIsBooting(false)
      }
    })

    return () => {
      isActive = false
      clearTimeout(timeoutId)
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (isBooting || !session?.user || profile || profileError) {
      setProfilePendingSince(0)
      return
    }
    if (!profilePendingSince) {
      setProfilePendingSince(Date.now())
      return
    }
    const stalledMs = Date.now() - profilePendingSince
    if (stalledMs >= 12000) {
      setProfileError('Profile load stalled. Tap Retry Profile Load or Reset Session.')
    }
  }, [isBooting, session, profile, profileError, profilePendingSince])

  const handleSignOut = async () => {
    if (!supabase) return
    await supabase.auth.signOut()
  }

  const refreshProfile = async () => {
    if (!session?.user) {
      setProfileError('Session missing user identity. Reset Session and sign in again.')
      return null
    }
    return fetchProfile(session.user)
  }

  const pushXpGain = (amount) => {
    setXpPulse(Number(amount || 0))
  }

  const clearXpPulse = () => {
    setXpPulse(0)
  }

  const weeklyXP = useMemo(() => getProfileXp(profile), [profile])

  if (isBooting) {
    return (
      <main className="auth-shell">
        <div className="panel auth-panel">
          <p>Loading...</p>
          {bootError ? <p className="error-text">{bootError}</p> : null}
          {bootWarning ? <p className="muted">{bootWarning}</p> : null}
        </div>
      </main>
    )
  }

  if (hasAuthCallbackParams()) {
    return <AuthCallbackPage />
  }

  if (!session) {
    return <AuthScreen />
  }

  if (profileError) {
    return (
      <main className="auth-shell">
        <div className="panel auth-panel">
          <p>Profile bootstrap failed: {String(profileError)}</p>
          {bootWarning ? <p className="muted">{bootWarning}</p> : null}
          <div className="actions">
            <button type="button" className="btn btn-cyan" onClick={refreshProfile}>Retry Profile Load</button>
            <button type="button" className="btn btn-red" onClick={handleSignOut}>Reset Session</button>
          </div>
        </div>
      </main>
    )
  }

  if (!profile) {
    return (
      <main className="auth-shell">
        <div className="panel auth-panel">
          <p>{profileError || 'Loading profile...'}</p>
          {bootWarning ? <p className="muted">{bootWarning}</p> : null}
          <div className="actions">
            <button type="button" className="btn btn-cyan" onClick={refreshProfile}>Retry Profile Load</button>
            <button type="button" className="btn btn-red" onClick={handleSignOut}>Reset Session</button>
          </div>
        </div>
      </main>
    )
  }

  if (!profile.path || !profile.username) {
    return <PathSelectScreen profile={profile} onSaved={refreshProfile} />
  }

  const pathConfig = PATH_CONFIG[profile.path] || PATH_CONFIG.HUNTER

  return (
    <AppContext.Provider value={{ session, profile, pathConfig, perksState }}>
      <AppShell
        onSignOut={handleSignOut}
        onProfileRefresh={refreshProfile}
        statPulse={xpPulse}
        onClearXpPulse={clearXpPulse}
        onXpGain={pushXpGain}
        weeklyXP={weeklyXP}
      />
    </AppContext.Provider>
  )
}

export default App
