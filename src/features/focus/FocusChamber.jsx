import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Check, CloudOff, Pause, Play, RotateCcw, ScrollText, Square, Wifi } from 'lucide-react'
import { useFocus, usePlayerData, useProfile } from '../../app/providers/contexts'
import { getPathConfig } from '../../config/pathConfig'
import { formatClock } from '../../lib/dates'
import { cx } from '../../lib/cx'
import { FOCUS_PRESETS, MAX_FOCUS_MINUTES, MIN_FOCUS_MINUTES, clampMinutes } from './focusEngine'
import { useQuestActions } from '../quests/useQuestActions'
import { Notice, Spinner } from '../../components/ui'

function TimerRing({ remainingMs, totalMs, status }) {
  const r = 46
  const c = 2 * Math.PI * r
  const progress = totalMs > 0 ? 1 - remainingMs / totalMs : 0
  const text = formatClock(remainingMs / 1000)
  return (
    <div className={cx('timer', `timer--${status}`)}>
      <svg viewBox="0 0 100 100" className="timer__ring" aria-hidden="true">
        <circle className="timer__track" cx="50" cy="50" r={r} />
        <circle
          className="timer__progress"
          cx="50"
          cy="50"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - progress)}
        />
      </svg>
      <div className="timer__readout" role="timer" aria-live="off" aria-label={`${text} remaining`}>
        {text.split('').map((ch, i) => (
          <span key={i} className={ch === ':' ? 'timer__sep' : 'timer__digit'}>
            {ch}
          </span>
        ))}
      </div>
    </div>
  )
}

function SyncBadge({ syncState }) {
  if (syncState === 'synced') {
    return (
      <span className="sync-badge sync-badge--ok">
        <Wifi size={14} aria-hidden="true" /> Recording to your account
      </span>
    )
  }
  if (syncState === 'offline') {
    return (
      <span className="sync-badge sync-badge--warn">
        <CloudOff size={14} aria-hidden="true" /> Not recorded (offline)
      </span>
    )
  }
  return (
    <span className="sync-badge">
      <Spinner label="Connecting" /> Connecting…
    </span>
  )
}

function SetupView({ pathConfig, preselectId }) {
  const { activeQuests } = usePlayerData()
  const focus = useFocus()
  const quests = activeQuests.data || []
  const [questId, setQuestId] = useState(() =>
    preselectId && quests.some((q) => q.id === preselectId) ? preselectId : preselectId || '',
  )
  const [preset, setPreset] = useState('sprint')
  const [custom, setCustom] = useState(25)

  const minutes = preset === 'custom' ? clampMinutes(custom) : FOCUS_PRESETS.find((p) => p.id === preset).minutes
  const selected = quests.find((q) => q.id === questId)

  const onStart = (event) => {
    event.preventDefault()
    focus.startSession({
      minutes,
      quest: selected ? { activeQuestId: selected.id, title: selected.quest.title } : null,
    })
  }

  return (
    <form className="focus-setup" onSubmit={onStart}>
      <label className="field">
        <span className="field__label">Focus on</span>
        <select className="input select" value={questId} onChange={(e) => setQuestId(e.target.value)}>
          <option value="">No specific {pathConfig.questNoun.toLowerCase()} (free focus)</option>
          {quests.map((q) => (
            <option key={q.id} value={q.id}>
              {q.quest.title}
            </option>
          ))}
        </select>
        {quests.length === 0 && activeQuests.status === 'ready' ? (
          <span className="field__hint">
            No active quests. <Link to="/quests">Accept one</Link> to link your session to it.
          </span>
        ) : null}
      </label>

      <fieldset className="field">
        <legend className="field__label">Duration</legend>
        <div className="chip-row">
          {FOCUS_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={cx('chip', preset === p.id && 'is-active')}
              aria-pressed={preset === p.id}
              onClick={() => setPreset(p.id)}
            >
              {p.label} · {p.minutes}m
            </button>
          ))}
          <button
            type="button"
            className={cx('chip', preset === 'custom' && 'is-active')}
            aria-pressed={preset === 'custom'}
            onClick={() => setPreset('custom')}
          >
            Custom
          </button>
        </div>
        {preset === 'custom' ? (
          <label className="inline-field">
            <input
              className="input input--narrow"
              type="number"
              min={MIN_FOCUS_MINUTES}
              max={MAX_FOCUS_MINUTES}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              aria-label="Custom minutes"
            />
            <span className="muted">minutes ({MIN_FOCUS_MINUTES}–{MAX_FOCUS_MINUTES})</span>
          </label>
        ) : null}
      </fieldset>

      <p className="fine-print">
        Earn 1 XP per 5 focused minutes (up to 48 XP a day). The server checks that real time has passed, so the
        timer keeps going if you switch tabs, navigate or reload.
      </p>

      <button type="submit" className="btn btn--primary btn--lg btn--block">
        <Play size={18} aria-hidden="true" /> Begin {minutes}-minute session
      </button>
    </form>
  )
}

function CompletedView({ result, quest, sessionId, onDone }) {
  const { activeQuests } = usePlayerData()
  const { complete, pending } = useQuestActions()
  const instance = quest ? (activeQuests.data || []).find((q) => q.id === quest.activeQuestId) : null
  const minutes = Math.round((result?.focusedSeconds || 0) / 60)

  return (
    <div className="focus-summary">
      <p className="eyebrow">Session complete</p>
      <h2 className="focus-summary__title">
        {minutes} focused minute{minutes === 1 ? '' : 's'}
      </h2>
      {result?.recorded ? (
        <p className="focus-summary__xp tabular">
          {result.xpAwarded > 0 ? `+${result.xpAwarded} XP earned` : 'Recorded to your history'}
        </p>
      ) : null}
      {result?.message ? <Notice tone={result.recorded ? 'info' : 'warning'}>{result.message}</Notice> : null}

      {instance ? (
        <div className="focus-summary__quest">
          <p className="muted">Linked quest: {instance.quest.title}</p>
          <button
            type="button"
            className="btn btn--primary"
            disabled={pending[`complete:${instance.id}`]}
            onClick={async () => {
              const res = await complete(instance, { focusSessionId: result?.recorded ? sessionId : null })
              if (res) onDone()
            }}
          >
            <Check size={17} aria-hidden="true" /> Complete quest (+{instance.quest.xpReward} XP)
          </button>
        </div>
      ) : quest ? (
        <p className="muted">Linked quest “{quest.title}” is no longer active.</p>
      ) : null}

      <div className="row-actions">
        <button type="button" className="btn btn--ghost" onClick={onDone}>
          <RotateCcw size={16} aria-hidden="true" /> New session
        </button>
        <Link to="/quests" className="btn btn--quiet">
          <ScrollText size={16} aria-hidden="true" /> Back to quests
        </Link>
      </div>
    </div>
  )
}

export default function FocusChamber() {
  const { profile } = useProfile()
  const pathConfig = getPathConfig(profile.path)
  const focus = useFocus()
  const location = useLocation()
  const { state } = focus
  const [confirmStop, setConfirmStop] = useState(false)
  const preselectId = location.state?.activeQuestId || ''
  const totalMs = state.plannedSeconds * 1000

  return (
    <div className="focus-page">
      <header className="focus-page__header">
        <p className="eyebrow">{pathConfig.title}</p>
        <h1 className="page-title">{pathConfig.focusTitle}</h1>
        <p className="page-lede">{pathConfig.focusLede}</p>
      </header>

      <section className="focus-stage" aria-label="Focus timer">
        {state.status === 'idle' ? (
          <SetupView pathConfig={pathConfig} preselectId={preselectId} />
        ) : state.status === 'completed' ? (
          <CompletedView result={state.result} quest={state.quest} sessionId={state.sessionId} onDone={focus.resetSession} />
        ) : (
          <div className="focus-live">
            <p className="focus-live__quest">
              {state.quest?.title ? (
                <>
                  <span className="muted">Focusing on</span> {state.quest.title}
                </>
              ) : (
                <span className="muted">Free focus</span>
              )}
            </p>
            <TimerRing remainingMs={focus.remainingMs} totalMs={totalMs} status={state.status} />
            <p className="focus-live__state" aria-live="polite">
              {state.status === 'paused' ? 'Paused' : state.status === 'finishing' ? 'Recording…' : 'In session'}
              {' · '}
              {Math.round(state.plannedSeconds / 60)} min planned
            </p>
            <SyncBadge syncState={state.syncState} />
            <div className="focus-live__controls">
              {state.status === 'running' ? (
                <button type="button" className="btn btn--ghost btn--lg" onClick={focus.pauseSession}>
                  <Pause size={18} aria-hidden="true" /> Pause
                </button>
              ) : state.status === 'paused' ? (
                <button type="button" className="btn btn--primary btn--lg" onClick={focus.resumeSession}>
                  <Play size={18} aria-hidden="true" /> Resume
                </button>
              ) : null}
              {confirmStop ? (
                <span className="confirm-inline">
                  <span className="fine-print">End without recording?</span>
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    onClick={() => {
                      setConfirmStop(false)
                      focus.resetSession()
                    }}
                  >
                    End session
                  </button>
                  <button type="button" className="btn btn--quiet btn--sm" onClick={() => setConfirmStop(false)}>
                    Keep going
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn--quiet btn--lg"
                  onClick={() => setConfirmStop(true)}
                  disabled={state.status === 'finishing'}
                >
                  <Square size={16} aria-hidden="true" /> Reset
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
