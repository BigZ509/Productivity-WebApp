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
  const safeUsername = (user.email?.split('@')[0] || `player_${user.id.slice(0, 6)}`).slice(0, 24)

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
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ username: username.trim(), path: pathKey })
      .eq('id', profile.id)

    setIsSaving(false)

    if (updateError) {
      setError(updateError.message)
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
          setHasSession(ok)
          setStatus(ok ? 'Email verified. You are ready.' : 'Verification complete. Please login to continue.')
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

function DashboardPage() {
  const { pathConfig, profile } = useApp()
  const [dailyClaimed, setDailyClaimed] = useState(false)
  const totalXP = getProfileXp(profile)
  const level = levelFromXp(totalXP)
  const rank = getRankInfo(totalXP).rank
  const scrollToSection = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
        <button type="button" className="btn btn-green" disabled={dailyClaimed} onClick={() => setDailyClaimed(true)}>
          {dailyClaimed ? 'CLAIMED' : 'CLAIM +10 XP'}
        </button>
      </div>

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
        <div className="panel-sub">// your current active quests - max 3</div>
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
      .eq('status', 'active')
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
    setActiveQuests(activeRes.data || [])
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
    const { error: rpcError } = await supabase.rpc('select_quest', { p_quest_id: questId })
    if (rpcError) {
      setError(rpcError.message)
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

    const { data, error: rpcError } = await supabase.rpc('complete_quest', {
      p_quest_id: questId,
    })

    if (rpcError) {
      setError(rpcError.message)
      return
    }

    const result = Array.isArray(data) ? data[0] : data
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
    await onProfileRefresh()
    if (import.meta.env.DEV) {
      console.debug('[quest.complete] profile refresh requested')
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
                  const disabled = activeQuestIds.has(quest.id) || activeQuests.length >= 3
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
        <div className="panel-sub">// your current active quests - max 3 at a time</div>
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
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [challengeTitle, setChallengeTitle] = useState('Weekly Raid: 200 total completions')
  const [newGroupName, setNewGroupName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [selectedGuildName, setSelectedGuildName] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const toXpValue = (row) => Number(row?.xp_total ?? row?.total_xp ?? row?.xp ?? 0)

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
      .select('id, name, created_by, capacity, created_at')
      .order('name', { ascending: true })

    if (allGroupsRes.error) {
      const msg = String(allGroupsRes.error.message || '').toLowerCase()
      if (msg.includes('column') && msg.includes('capacity')) {
        allGroupsRes = await supabase
          .from('groups')
          .select('id, name, created_by, created_at')
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

  useEffect(() => {
    loadGroups()
    loadAllGroups()
    loadMemberCounts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id])

  useEffect(() => {
    loadGuildPreviewBoard(selectedGroupId)
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
    if (!joinCode.trim()) return

    const joinRes = await supabase.rpc('join_guild_by_code', { p_code: joinCode.trim().toUpperCase() })
    if (joinRes.error) {
      setError(joinRes.error.message)
      return
    }
    setMessage('Joined guild.')
    setJoinCode('')
    loadGroups()
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

  return (
    <section className="tab-content active">
      {error ? <p className="error-text">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}

      <form className="panel form-stack" onSubmit={onCreateGuild}>
        <div className="panel-title">Create Guild</div>
        <input
          className="zbxp-input"
          value={newGroupName}
          onChange={(event) => setNewGroupName(event.target.value)}
          placeholder="Guild name"
          maxLength={50}
        />
        <button type="submit" className="btn btn-purple">Create Guild</button>
      </form>

      <form className="panel form-stack" onSubmit={onJoinGuild}>
        <div className="panel-title">Join Guild By Code</div>
        <input
          className="zbxp-input"
          value={joinCode}
          onChange={(event) => setJoinCode(event.target.value)}
          placeholder="Invite code"
          maxLength={12}
        />
        <button type="submit" className="btn btn-cyan">Join Guild</button>
      </form>

      <div className="panel">
        <div className="panel-title">My Guilds</div>
        <div className="actions" style={{ marginBottom: '8px' }}>
          <button type="button" className="btn btn-cyan" onClick={loadGroups}>Refresh My Guilds</button>
        </div>
        <div className="actions">
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className={cx('history-item', 'guild-row-btn', 'guild-v4-row', selectedGroupId === group.id && 'is-selected')}
              onClick={() => {
                setSelectedGroupId(group.id)
                setSelectedGuildName(group.name)
                setMessage(`Selected guild: ${group.name}`)
              }}
            >
              <strong>{group.name}</strong>
              <span className="muted">Member guild • click to set active</span>
            </button>
          ))}
        </div>
        {groups.length === 0 ? <p className="muted">No guild memberships yet.</p> : null}
        {selectedGuildName ? <p className="muted">Active guild: {selectedGuildName}</p> : null}
      </div>

      <div className="panel">
        <div className="panel-title">World Guild Directory</div>
        <div className="panel-sub">// browse every guild - joining still requires access</div>
        <div className="actions" style={{ marginTop: '8px', marginBottom: '8px' }}>
          <button type="button" className="btn btn-cyan" onClick={() => { loadAllGroups(); loadMemberCounts() }}>Refresh World Guilds</button>
        </div>
        <div className="actions" style={{ marginTop: '10px' }}>
          {allGroups.map((group) => {
            const isMember = groups.some((entry) => entry.id === group.id)
            const capacity = Number(group.capacity || 10)
            const members = Number(memberCounts[group.id] || 0)
            const openSpots = Math.max(0, capacity - members)
            return (
              <button
                key={group.id}
                type="button"
                className={cx('history-item', 'guild-row-btn', 'guild-v4-row', selectedGroupId === group.id && 'is-selected')}
                onClick={() => {
                  setSelectedGroupId(group.id)
                  setSelectedGuildName(group.name)
                  setMessage(
                    isMember
                      ? `Selected guild: ${group.name}`
                      : `Viewing ${group.name}. Access is required before you can participate.`,
                  )
                }}
              >
                <strong>{group.name}</strong>
                <span className="muted">Members: {members} / {capacity}</span>
                <span className="muted">Open spots: {openSpots}</span>
                <span className="muted">{isMember ? 'You are a member' : 'View only until joined/approved'}</span>
              </button>
            )
          })}
        </div>
        {allGroups.length === 0 ? <p className="muted">No guilds visible in directory yet. Check `groups` select policy and click refresh.</p> : null}
      </div>

      <div className="panel">
        <div className="panel-title">Guild Preview</div>
        <div className="panel-sub">// top members in selected guild (read-only preview)</div>
        <ul className="clean-list">
          {guildPreviewBoard.map((row, index) => (
            <li key={`${row.user_id}-${index}`} className="history-item leaderboard-v4-row">
              <strong>#{index + 1} {row.username || 'Unknown'}</strong>
              <span>{row.xp_total ?? row.xp ?? 0} XP</span>
            </li>
          ))}
        </ul>
        {selectedGroupId && guildPreviewBoard.length === 0 ? <p className="muted">No preview rows for this guild yet.</p> : null}
        {!selectedGroupId ? <p className="muted">Select a guild from the directory to view top members.</p> : null}
      </div>

      <div className="panel">
        <div className="panel-title">Guild Raid</div>
        <div className="panel-sub">// group contribution objective with deadline</div>
        <label className="input-label">
          Raid challenge title
          <input
            className="zbxp-input"
            value={challengeTitle}
            onChange={(event) => setChallengeTitle(event.target.value)}
            maxLength={120}
          />
        </label>
        <div className="challenge-card" style={{ marginTop: '12px' }}>
          <div className="challenge-title">{challengeTitle}</div>
          <div className="ch-track"><div className="ch-fill" style={{ width: '35%' }} /></div>
          <div className="ch-foot">
            <span>Progress: <span>70 / 200</span></span>
            <span>Deadline: <span>4 days</span></span>
          </div>
        </div>
        <button type="button" className="btn btn-gold" onClick={onCreateChallenge}>
          Create Raid Challenge
        </button>
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
    if (result?.awarded_xp && Number(result.awarded_xp) > 0) {
      onXpGain(Number(result.awarded_xp))
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
    await onProfileRefresh()
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
                <div className="time-slot-time">{item.time}</div>
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

    setBoard(boardRes.data || [])
  }

  const loadAllGroups = async () => {
    const { data, error: allGroupsError } = await supabase
      .from('groups')
      .select('id, name, created_by')
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
      .select('id, username, total_xp')
      .order('total_xp', { ascending: false })
      .limit(25)

    if (res.error && String(res.error.message || '').toLowerCase().includes('total_xp')) {
      res = await supabase
        .from('profiles')
        .select('id, username, xp_total')
        .order('xp_total', { ascending: false })
        .limit(25)
    }

    if (res.error) {
      setError((prev) => prev || res.error.message)
      return
    }

    const normalized = (res.data || []).map((row) => ({
      user_id: row.id,
      username: row.username,
      xp_total: Number(row.total_xp ?? row.xp_total ?? 0),
    }))
    setGlobalBoard(normalized)
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
              <strong>{row.username || 'Unknown'}</strong>
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
              <strong>#{index + 1} {row.username || 'Unknown'}</strong>
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
            <Route path="/dashboard" element={<DashboardPage />} />
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
  const [xpPulse, setXpPulse] = useState(0)
  const perksState = usePerks()

  const fetchProfile = async (user) => {
    try {
      const nextProfile = await withTimeout(ensureProfile(user), 12000, 'Profile load timed out. Please sign in again.')
      const normalizedProfile = {
        ...nextProfile,
        total_xp: Number(nextProfile?.total_xp ?? nextProfile?.xp_total ?? 0),
      }
      setProfile(normalizedProfile)
      setProfileError('')
      return normalizedProfile
    } catch (error) {
      const message = error?.message || 'Failed to load profile'
      if (isAuthLockTimeoutError(message)) {
        setBootError('Session lock timed out. Close other ZBXP tabs/windows, then sign in again.')
        setSession(null)
        setProfile(null)
        setProfileError('')
        return null
      }
      setProfileError(message)
      return null
    }
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
        const { data, error } = await withTimeout(
          supabase.auth.getSession(),
          8000,
          'Auth session restore timed out. Please sign in again.',
        )
        if (!isActive) return

        if (error) {
          if (isAuthLockTimeoutError(error)) {
            setBootError('Session lock timed out. Close other ZBXP tabs/windows, then sign in again.')
            setSession(null)
            setProfile(null)
            return
          }
          setBootError(error.message || 'Failed to restore session')
          setSession(null)
          return
        }

        setSession(data.session)
        if (data.session?.user) {
          await fetchProfile(data.session.user)
        }
      } catch (error) {
        if (!isActive) return
        if (isAuthLockTimeoutError(error)) {
          setBootError('Session lock timed out. Close other ZBXP tabs/windows, then sign in again.')
          setSession(null)
          setProfile(null)
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
      setBootError((prev) => prev || 'Auth bootstrap timed out. Please refresh and try again.')
      setIsBooting(false)
    }, 9000)

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      try {
        setSession(nextSession)
        if (nextSession?.user) {
          await fetchProfile(nextSession.user)
        } else {
          setProfile(null)
        }
      } catch (error) {
        if (isAuthLockTimeoutError(error)) {
          setBootError('Session lock timed out. Close other ZBXP tabs/windows, then sign in again.')
          setSession(null)
          setProfile(null)
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

  const handleSignOut = async () => {
    if (!supabase) return
    await supabase.auth.signOut()
  }

  const refreshProfile = async () => {
    if (!session?.user) return
    await fetchProfile(session.user)
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
        </div>
      </main>
    )
  }

  if (typeof window !== 'undefined' && window.location.pathname === '/auth/callback') {
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
