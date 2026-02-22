import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from './lib/supabaseClient'
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

async function ensureProfile(userId) {
  const { data: existing, error: queryError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle()

  if (queryError) throw queryError
  if (existing) return existing

  const { error: insertError } = await supabase.from('profiles').insert({ id: userId })
  if (insertError) throw insertError

  const { data: created, error: createdError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()

  if (createdError) throw createdError
  return created
}

function PathSelectScreen({ profile, onSaved }) {
  const [username, setUsername] = useState(profile?.username || '')
  const [pathKey, setPathKey] = useState(profile?.path_key || '')
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
      .update({ username: username.trim(), path_key: pathKey })
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
      <form className="card form-grid path-select-card" onSubmit={submit}>
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
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [feedback, setFeedback] = useState('')

  const onSubmit = async (event) => {
    event.preventDefault()
    setFeedback('')
    setIsSubmitting(true)

    const response =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })

    setIsSubmitting(false)

    if (response.error) {
      setFeedback(response.error.message)
      return
    }

    if (mode === 'signup' && !response.data.session) {
      setFeedback('Signup created. Confirm email, then sign in.')
      return
    }

    setFeedback('Authenticated. Loading profile...')
  }

  const signInDevAccount = async () => {
    setFeedback('')
    setIsSubmitting(true)
    const { error } = await supabase.auth.signInWithPassword({
      email: 'test@test.com',
      password: '123456',
    })
    setIsSubmitting(false)
    if (error) {
      setFeedback(error.message)
      return
    }
    setFeedback('Signed in with QA account.')
  }

  return (
    <main className="auth-shell">
      <form className="card form-grid auth-card" onSubmit={onSubmit}>
        <h2>{mode === 'signin' ? 'Sign in' : 'Create account'}</h2>

        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            minLength={6}
            required
          />
        </label>

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Please wait...' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>

        {import.meta.env.DEV ? (
          <button type="button" className="text-button" onClick={signInDevAccount} disabled={isSubmitting}>
            Dev Login
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

        {feedback ? <p className="muted">{feedback}</p> : null}
      </form>
    </main>
  )
}

function ProfileHUD({ profile, weeklyXP, statPulse }) {
  const { pathConfig, perksState } = useApp()
  const totalXP = profile?.total_xp || 0
  const level = levelFromXp(totalXP)
  const progress = totalXP % 100

  return (
    <section className="card profile-hud">
      <div className="row-between">
        <div>
          <p className="brand-eyebrow">{pathConfig.worldLabel}</p>
          <h2>{pathConfig.title}</h2>
          <p className="muted">{profile?.username || 'Unnamed'}</p>
        </div>
        <div className="stack-sm hud-badges">
          <span className="hud-badge">Level {level}</span>
          {perksState.isQA ? <span className="hud-badge qa-badge">QA</span> : null}
        </div>
      </div>

      <div className="xp-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <span className="xp-fill" style={{ width: `${progress}%` }} />
      </div>

      <div className="hud-stats row-between">
        <strong className={cx('hud-stat', statPulse > 0 && 'is-pulsing')}>
          {totalXP} XP {statPulse > 0 ? <span className="gain-chip">+{statPulse}</span> : null}
        </strong>
        <strong className="hud-stat">Weekly XP: {weeklyXP}</strong>
      </div>
    </section>
  )
}

function DashboardPage() {
  const { pathConfig } = useApp()

  return (
    <section className="stack">
      <div className="card">
        <h3>{pathConfig.dashboardTitle}</h3>
        <p className="muted">{pathConfig.dashboardFlavor}</p>
      </div>
      <div className="card">
        <h3>Mirror Mode</h3>
        <p>
          You are on the <strong>{pathConfig.title}</strong> path. Core systems stay the same, but language, questline,
          and vibe mirror your path identity.
        </p>
      </div>
    </section>
  )
}

function QuestsPage({ onProfileRefresh, onXpGain }) {
  const { profile, pathConfig } = useApp()
  const [availableQuests, setAvailableQuests] = useState([])
  const [activeQuests, setActiveQuests] = useState([])
  const [history, setHistory] = useState([])
  const [noteDrafts, setNoteDrafts] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadQuestData = async () => {
    setLoading(true)
    setError('')

    const [availableRes, activeRes, historyRes] = await Promise.all([
      supabase
        .from('quests')
        .select('*')
        .eq('is_active', true)
        .eq('path_key', profile.path_key)
        .order('xp_reward', { ascending: true }),
      supabase
        .from('user_active_quests')
        .select('id, selected_at, status, quest:quests(*)')
        .eq('user_id', profile.id)
        .eq('status', 'active')
        .order('selected_at', { ascending: false }),
      supabase
        .from('quest_completions')
        .select('id, completed_at, note, quest:quests(title, category, difficulty, xp_reward)')
        .eq('user_id', profile.id)
        .order('completed_at', { ascending: false })
        .limit(25),
    ])

    if (availableRes.error || activeRes.error || historyRes.error) {
      setError(availableRes.error?.message || activeRes.error?.message || historyRes.error?.message || 'Load failed')
      setLoading(false)
      return
    }

    setAvailableQuests(availableRes.data || [])
    setActiveQuests(activeRes.data || [])
    setHistory(historyRes.data || [])
    setLoading(false)
  }

  useEffect(() => {
    loadQuestData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, profile.path_key])

  const onSelectQuest = async (questId) => {
    setError('')
    const { error: rpcError } = await supabase.rpc('select_quest', { p_quest_id: questId })
    if (rpcError) {
      setError(rpcError.message)
      return
    }
    loadQuestData()
  }

  const onCompleteQuest = async (activeQuestId) => {
    setError('')
    const note = noteDrafts[activeQuestId] || null
    const { data, error: rpcError } = await supabase.rpc('complete_quest', {
      p_active_quest_id: activeQuestId,
      p_optional_note: note,
    })

    if (rpcError) {
      setError(rpcError.message)
      return
    }

    const result = Array.isArray(data) ? data[0] : data
    if (result?.awarded && Number(result?.awarded_xp) > 0) {
      onXpGain(Number(result.awarded_xp))
    }

    await onProfileRefresh()
    loadQuestData()
  }

  const activeQuestIds = new Set(activeQuests.map((item) => item.quest?.id))

  return (
    <section className="stack">
      <div className="card">
        <h3>{pathConfig.questBoardTitle}</h3>
        <p className="muted">{pathConfig.questBoardFlavor}</p>
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="card">
        <div className="row-between">
          <h3>Quest Board</h3>
          <span className="muted">Active limit: 3</span>
        </div>

        {loading ? (
          <p className="muted">Loading quests...</p>
        ) : (
          <div className="stack-sm">
            {availableQuests.map((quest) => {
              const disabled = activeQuestIds.has(quest.id) || activeQuests.length >= 3
              return (
                <article key={quest.id} className="quest-item">
                  <div>
                    <strong>{quest.title}</strong>
                    <p className="muted">{quest.category} • {quest.difficulty} • {quest.xp_reward} XP</p>
                    {quest.flavor_text ? <p className="muted">{quest.flavor_text}</p> : null}
                  </div>
                  <button type="button" onClick={() => onSelectQuest(quest.id)} disabled={disabled}>
                    {activeQuestIds.has(quest.id) ? 'Selected' : 'Select Quest'}
                  </button>
                </article>
              )
            })}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Active Quests</h3>
        {activeQuests.length === 0 ? <p className="muted">No active quests yet.</p> : null}
        <div className="stack-sm">
          {activeQuests.map((entry) => (
            <article key={entry.id} className="quest-item">
              <div className="stack-sm">
                <strong>{entry.quest?.title}</strong>
                <p className="muted">{entry.quest?.category} • {entry.quest?.difficulty} • {entry.quest?.xp_reward} XP</p>
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
              <button type="button" onClick={() => onCompleteQuest(entry.id)}>
                Complete
              </button>
            </article>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Quest History</h3>
        <ul className="clean-list">
          {history.map((item) => (
            <li key={item.id} className="history-item">
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
    days.push({
      date: key,
      status: row ? (row.completed ? 'done' : 'missed') : 'neutral',
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

function GymPage({ onProfileRefresh, onXpGain }) {
  const { profile, pathConfig } = useApp()
  const [plans, setPlans] = useState([])
  const [selectedPlan, setSelectedPlan] = useState(null)
  const [planDays, setPlanDays] = useState([])
  const [logs, setLogs] = useState([])
  const [logDate, setLogDate] = useState(todayIso())
  const [completed, setCompleted] = useState(true)
  const [exerciseNotes, setExerciseNotes] = useState('')
  const [error, setError] = useState('')

  const loadGymData = async () => {
    setError('')

    const [plansRes, selectedRes, logsRes] = await Promise.all([
      supabase
        .from('workout_plans')
        .select('*')
        .eq('is_active', true)
        .eq('path_key', profile.path_key)
        .order('created_at', { ascending: true }),
      supabase
        .from('user_selected_workout_plans')
        .select('plan_id, plan:workout_plans(*)')
        .eq('user_id', profile.id)
        .maybeSingle(),
      supabase
        .from('workout_logs')
        .select('id, log_date, completed')
        .eq('user_id', profile.id)
        .gte('log_date', formatDate(new Date(Date.now() - 35 * 24 * 60 * 60 * 1000)))
        .order('log_date', { ascending: true }),
    ])

    if (plansRes.error || selectedRes.error || logsRes.error) {
      setError(plansRes.error?.message || selectedRes.error?.message || logsRes.error?.message || 'Load failed')
      return
    }

    setPlans(plansRes.data || [])
    setLogs(logsRes.data || [])

    const pickedPlan = selectedRes.data?.plan || null
    setSelectedPlan(pickedPlan)

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
  }, [profile.id, profile.path_key])

  const onSelectPlan = async (planId) => {
    setError('')
    const { error: rpcError } = await supabase.rpc('select_workout_plan', { p_plan_id: planId })
    if (rpcError) {
      setError(rpcError.message)
      return
    }
    loadGymData()
  }

  const onLogWorkout = async (event) => {
    event.preventDefault()
    setError('')

    const payload = {
      notes: exerciseNotes,
    }

    const { data, error: rpcError } = await supabase.rpc('log_workout', {
      p_date: logDate,
      p_completed: completed,
      p_optional_payload: payload,
    })

    if (rpcError) {
      setError(rpcError.message)
      return
    }

    const result = Array.isArray(data) ? data[0] : data
    if (result?.awarded_xp && Number(result.awarded_xp) > 0) {
      onXpGain(Number(result.awarded_xp))
    }

    setExerciseNotes('')
    await onProfileRefresh()
    loadGymData()
  }

  const days = buildLast30Days(logs)
  const streak = calcStreaks(logs)

  return (
    <section className="stack">
      <div className="card">
        <h3>{pathConfig.gymTitle}</h3>
        <p className="muted">{pathConfig.gymFlavor}</p>
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="card">
        <h3>Workout Plans</h3>
        <div className="stack-sm">
          {plans.map((plan) => (
            <article key={plan.id} className="quest-item">
              <div>
                <strong>{plan.name}</strong>
                <p className="muted">{plan.description}</p>
              </div>
              <button type="button" onClick={() => onSelectPlan(plan.id)} disabled={selectedPlan?.id === plan.id}>
                {selectedPlan?.id === plan.id ? 'Selected' : 'Select Plan'}
              </button>
            </article>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Plan Day Templates</h3>
        {selectedPlan ? <p className="muted">Current plan: {selectedPlan.name}</p> : <p className="muted">Select a plan first.</p>}
        <ul className="clean-list">
          {planDays.map((day) => (
            <li key={day.id} className="history-item">
              <strong>Day {day.day_number}: {day.title}</strong>
              <span className="muted">{JSON.stringify(day.template || {}, null, 0)}</span>
            </li>
          ))}
        </ul>
      </div>

      <form className="card form-grid" onSubmit={onLogWorkout}>
        <h3>Log Workout</h3>
        <label>
          Date
          <input type="date" value={logDate} onChange={(event) => setLogDate(event.target.value)} required />
        </label>

        <label className="checkbox-row">
          <input type="checkbox" checked={completed} onChange={(event) => setCompleted(event.target.checked)} />
          Completed workout
        </label>

        <label>
          Exercises completed / notes (optional)
          <input
            value={exerciseNotes}
            onChange={(event) => setExerciseNotes(event.target.value)}
            maxLength={220}
            placeholder="e.g., Push day done, added incline dumbbell press"
          />
        </label>

        <button type="submit">Log Workout</button>
      </form>

      <div className="card">
        <div className="row-between">
          <h3>30 Day Streak Grid</h3>
          <p className="muted">Current: {streak.current} • Longest: {streak.longest}</p>
        </div>
        <div className="streak-grid">
          {days.map((day) => (
            <span key={day.date} className={cx('streak-cell', `is-${day.status}`)} title={day.date} />
          ))}
        </div>
      </div>
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
    <article className={cx('stat-card', isAnimating && 'is-up')}>
      <p className="muted">{label}</p>
      <strong>{value}</strong>
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
          .select('quest:quests(category)')
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
        const category = String(row.quest?.category || '').toLowerCase()
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

  const level = levelFromXp(profile.total_xp || 0)
  const xpProgress = (profile.total_xp || 0) % 100

  return (
    <section className="stack">
      {error ? <p className="error-text">{error}</p> : null}
      <div className="card">
        <h3>Stats Core</h3>
        <p className="muted">Progress metrics with responsive stat-up indicators.</p>
      </div>

      <div className="stat-grid">
        <StatTile label="Level" value={level} />
        <StatTile label="Total XP" value={profile.total_xp || 0} />
        <StatTile label="Weekly XP" value={weeklyXP} />
        <StatTile label="All-Time XP (events)" value={allTimeXP} />
      </div>

      <div className="card">
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
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [timeframe, setTimeframe] = useState('weekly')
  const [board, setBoard] = useState([])
  const [challenges, setChallenges] = useState([])
  const [newGroupName, setNewGroupName] = useState('')
  const [newChallengeTitle, setNewChallengeTitle] = useState('')
  const [newChallengeType, setNewChallengeType] = useState('most_xp_week')
  const [newChallengeTarget, setNewChallengeTarget] = useState(10)
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
      setChallenges([])
      return
    }

    const [boardRes, challengeRes] = await Promise.all([
      supabase.rpc('get_leaderboard', {
        p_group_id: selectedGroupId,
        p_timeframe: timeframe,
      }),
      supabase
        .from('challenges')
        .select('*')
        .eq('group_id', selectedGroupId)
        .order('created_at', { ascending: false }),
    ])

    if (boardRes.error || challengeRes.error) {
      setError(boardRes.error?.message || challengeRes.error?.message || 'Leaderboard load failed')
      return
    }

    setBoard(boardRes.data || [])
    setChallenges(challengeRes.data || [])
  }

  useEffect(() => {
    loadGroups()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id])

  useEffect(() => {
    loadBoard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId, timeframe])

  const createGroup = async (event) => {
    event.preventDefault()
    if (!newGroupName.trim()) return

    const { data: group, error: groupError } = await supabase
      .from('groups')
      .insert({ name: newGroupName.trim(), created_by: profile.id })
      .select('*')
      .single()

    if (groupError) {
      setError(groupError.message)
      return
    }

    const { error: memberError } = await supabase
      .from('group_members')
      .insert({ group_id: group.id, user_id: profile.id, role: 'owner' })

    if (memberError) {
      setError(memberError.message)
      return
    }

    setNewGroupName('')
    await loadGroups()
    setSelectedGroupId(group.id)
  }

  const createChallenge = async (event) => {
    event.preventDefault()
    if (!selectedGroupId || !newChallengeTitle.trim()) return

    const start = todayIso()
    const endDate = new Date()
    endDate.setDate(endDate.getDate() + 7)

    const { error: challengeError } = await supabase.from('challenges').insert({
      group_id: selectedGroupId,
      title: newChallengeTitle.trim(),
      challenge_type: newChallengeType,
      target_value: Number(newChallengeTarget) || 0,
      created_by: profile.id,
      start_date: start,
      end_date: formatDate(endDate),
      status: 'active',
    })

    if (challengeError) {
      setError(challengeError.message)
      return
    }

    setNewChallengeTitle('')
    loadBoard()
  }

  return (
    <section className="stack">
      {error ? <p className="error-text">{error}</p> : null}

      <form className="card form-grid" onSubmit={createGroup}>
        <h3>Friend Groups</h3>
        <label>
          Create Group
          <input
            value={newGroupName}
            onChange={(event) => setNewGroupName(event.target.value)}
            placeholder="e.g., Solo Leveling Squad"
            maxLength={80}
          />
        </label>
        <button type="submit">Create Group</button>
      </form>

      <div className="card">
        <h3>My Groups</h3>
        <div className="actions">
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className={cx(selectedGroupId === group.id && 'is-selected')}
              onClick={() => setSelectedGroupId(group.id)}
            >
              {group.name}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="row-between">
          <h3>Leaderboard</h3>
          <div className="actions">
            <button type="button" className={cx(timeframe === 'weekly' && 'is-selected')} onClick={() => setTimeframe('weekly')}>
              Weekly
            </button>
            <button type="button" className={cx(timeframe === 'all_time' && 'is-selected')} onClick={() => setTimeframe('all_time')}>
              All-Time
            </button>
          </div>
        </div>
        <ul className="clean-list">
          {board.map((row) => (
            <li key={row.user_id} className="history-item">
              <strong>{row.username || 'Unknown'}</strong>
              <span>{row.xp_total} XP</span>
            </li>
          ))}
        </ul>
      </div>

      <form className="card form-grid" onSubmit={createChallenge}>
        <h3>Challenges (MVP)</h3>
        <label>
          Title
          <input
            value={newChallengeTitle}
            onChange={(event) => setNewChallengeTitle(event.target.value)}
            placeholder="Most XP this week"
            maxLength={120}
          />
        </label>
        <label>
          Type
          <select value={newChallengeType} onChange={(event) => setNewChallengeType(event.target.value)}>
            <option value="most_xp_week">Most XP this week</option>
            <option value="complete_quests">Complete quests target</option>
          </select>
        </label>
        <label>
          Target
          <input
            type="number"
            min="1"
            value={newChallengeTarget}
            onChange={(event) => setNewChallengeTarget(Number(event.target.value))}
          />
        </label>
        <button type="submit" disabled={!selectedGroupId}>Create Challenge</button>
      </form>

      <div className="card">
        <h3>Active Challenges</h3>
        <ul className="clean-list">
          {challenges.map((challenge) => (
            <li key={challenge.id} className="history-item">
              <strong>{challenge.title}</strong>
              <span className="muted">{challenge.challenge_type} • target {challenge.target_value}</span>
              <span className="muted">{challenge.start_date} → {challenge.end_date}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function AppShell({ onSignOut, onProfileRefresh, statPulse, onClearXpPulse, onXpGain, weeklyXP }) {
  const { pathConfig, profile } = useApp()

  useEffect(() => {
    if (!statPulse) return
    const timeout = setTimeout(() => onClearXpPulse(), 1000)
    return () => clearTimeout(timeout)
  }, [statPulse, onClearXpPulse])

  return (
    <div className="app-shell" style={{ '--path-accent': pathConfig.accent, '--path-accent-soft': pathConfig.accentSoft }}>
      <header className="hud-header">
        <div>
          <p className="brand-eyebrow">ZBXP</p>
          <h1 className="brand-title">{pathConfig.shellTitle}</h1>
        </div>
        <button type="button" className="signout-btn" onClick={onSignOut}>Sign out</button>
      </header>

      <ProfileHUD profile={profile} weeklyXP={weeklyXP} statPulse={statPulse} />

      <nav className="hud-nav" aria-label="Primary navigation">
        <NavLink to="/dashboard" className={({ isActive }) => cx('hud-tab', isActive && 'is-active')}>
          Dashboard
        </NavLink>
        <NavLink to="/quests" className={({ isActive }) => cx('hud-tab', isActive && 'is-active')}>
          Quests
        </NavLink>
        <NavLink to="/gym" className={({ isActive }) => cx('hud-tab', isActive && 'is-active')}>
          Gym
        </NavLink>
        <NavLink to="/stats" className={({ isActive }) => cx('hud-tab', isActive && 'is-active')}>
          Stats
        </NavLink>
        <NavLink to="/leaderboard" className={({ isActive }) => cx('hud-tab', isActive && 'is-active')}>
          Leaderboard
        </NavLink>
      </nav>

      <main className="page-panel">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/quests" element={<QuestsPage onProfileRefresh={onProfileRefresh} onXpGain={onXpGain} />} />
          <Route path="/gym" element={<GymPage onProfileRefresh={onProfileRefresh} onXpGain={onXpGain} />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
        </Routes>
      </main>
    </div>
  )
}

function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [isBooting, setIsBooting] = useState(true)
  const [profileError, setProfileError] = useState('')
  const [xpPulse, setXpPulse] = useState(0)
  const perksState = usePerks()

  const fetchProfile = async (userId) => {
    try {
      const nextProfile = await ensureProfile(userId)
      setProfile(nextProfile)
      setProfileError('')
      return nextProfile
    } catch (error) {
      setProfileError(error.message || 'Failed to load profile')
      return null
    }
  }

  useEffect(() => {
    let isActive = true

    supabase.auth.getSession().then(async ({ data, error }) => {
      if (!isActive) return
      if (error) {
        setSession(null)
        setIsBooting(false)
        return
      }

      setSession(data.session)
      if (data.session?.user?.id) {
        await fetchProfile(data.session.user.id)
      }
      setIsBooting(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      setSession(nextSession)
      if (nextSession?.user?.id) {
        await fetchProfile(nextSession.user.id)
      } else {
        setProfile(null)
      }
      setIsBooting(false)
    })

    return () => {
      isActive = false
      subscription.unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
  }

  const refreshProfile = async () => {
    if (!session?.user?.id) return
    await fetchProfile(session.user.id)
  }

  const pushXpGain = (amount) => {
    setXpPulse(Number(amount || 0))
  }

  const clearXpPulse = () => {
    setXpPulse(0)
  }

  const weeklyXP = useMemo(() => {
    if (!profile?.total_xp) return 0
    return profile.total_xp
  }, [profile?.total_xp])

  if (isBooting) {
    return (
      <main className="auth-shell">
        <div className="card auth-card">Loading...</div>
      </main>
    )
  }

  if (!session) {
    return <AuthScreen />
  }

  if (!profile) {
    return (
      <main className="auth-shell">
        <div className="card auth-card">
          <p>{profileError || 'Loading profile...'}</p>
        </div>
      </main>
    )
  }

  if (!profile.path_key || !profile.username) {
    return <PathSelectScreen profile={profile} onSaved={refreshProfile} />
  }

  const pathConfig = PATH_CONFIG[profile.path_key] || PATH_CONFIG.HUNTER

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
