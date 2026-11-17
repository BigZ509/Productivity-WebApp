import { useState } from 'react'
import { Check, Dumbbell, Flame, HeartPulse } from 'lucide-react'
import { usePlayerData, useProfile, useRewards } from '../../app/providers/contexts'
import { getPathConfig } from '../../config/pathConfig'
import { buildDayGrid, loadPlanDays, loadTrainingData, recordWorkout, selectWorkoutPlan } from '../../services/workouts'
import { useLoader } from '../../hooks/useLoader'
import { addDays, dayKey } from '../../lib/dates'
import { describeGain } from '../../lib/progression'
import { cx } from '../../lib/cx'
import { AsyncBlock, EmptyState, Notice, PageHeader, Panel, Spinner } from '../../components/ui'

function DayDetail({ day, checked, onToggle }) {
  if (!day) return null
  const done = day.exercises.filter((_, i) => checked.has(i)).length
  return (
    <div className="day-detail">
      <div className="day-detail__head">
        <div>
          <h3 className="day-detail__title">{day.title}</h3>
          {day.focus ? <p className="muted">{day.focus}</p> : null}
        </div>
        {day.cardio ? (
          <span className="status-tag">
            <HeartPulse size={14} aria-hidden="true" /> {day.cardio}
          </span>
        ) : null}
      </div>
      <ul className="exercise-list">
        {day.exercises.map((ex, i) => (
          <li key={`${ex}-${i}`}>
            <label className={cx('exercise', checked.has(i) && 'is-done')}>
              <input type="checkbox" checked={checked.has(i)} onChange={() => onToggle(i)} />
              <span className="exercise__num tabular">{String(i + 1).padStart(2, '0')}</span>
              <span className="exercise__name">{ex}</span>
              <span className="exercise__check" aria-hidden="true">
                {checked.has(i) ? <Check size={15} /> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="fine-print tabular">
        {done}/{day.exercises.length} checked. The checklist helps you track the session; XP is awarded when you log it
        below.
      </p>
    </div>
  )
}

function LogForm({ dayTitle, exercisesDone, onLogged }) {
  const { profile, refresh } = useProfile()
  const { xpEvents } = usePlayerData()
  const { showReward, toast } = useRewards()
  const today = dayKey(new Date())
  const [date, setDate] = useState(today)
  const [completed, setCompleted] = useState(true)
  const [walk, setWalk] = useState(false)
  const [run, setRun] = useState(false)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e) => {
    e.preventDefault()
    setBusy(true)
    const before = profile.xp
    try {
      const res = await recordWorkout({
        date,
        completed,
        notes,
        bonusWalk: walk,
        bonusRun: run,
        planDay: dayTitle,
        exercisesDone,
      })
      const updated = await refresh()
      xpEvents.reload()
      if (res.xpAwarded > 0) {
        showReward({
          xp: res.xpAwarded,
          title: 'Workout logged',
          subtitle: `Workout streak: ${res.currentStreak} day${res.currentStreak === 1 ? '' : 's'}`,
          gain: describeGain(before, updated?.xp ?? before + res.xpAwarded, profile.path),
        })
      } else {
        toast(
          completed
            ? 'Workout updated. XP for this day was already awarded.'
            : 'Saved as a missed day. No XP awarded.',
          'info',
        )
      }
      setNotes('')
      setWalk(false)
      setRun(false)
      onLogged()
    } catch (err) {
      toast(err.message, 'error', { duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="form" onSubmit={onSubmit}>
      <label className="field">
        <span className="field__label">Date</span>
        <input
          className="input"
          type="date"
          value={date}
          min={dayKey(addDays(new Date(), -2))}
          max={today}
          onChange={(e) => setDate(e.target.value)}
          required
        />
        <span className="field__hint">You can log today or the previous two days.</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={completed} onChange={(e) => setCompleted(e.target.checked)} />
        <span>I completed this workout (+40 XP, once per day)</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={walk} onChange={(e) => setWalk(e.target.checked)} disabled={!completed} />
        <span>Bonus: 45-minute walk (+10 XP)</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={run} onChange={(e) => setRun(e.target.checked)} disabled={!completed} />
        <span>Bonus: 45-minute run (+15 XP)</span>
      </label>
      <label className="field">
        <span className="field__label">Notes (optional)</span>
        <input
          className="input"
          value={notes}
          maxLength={220}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Added a set of incline press"
        />
      </label>
      <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
        {busy ? <Spinner label="Logging" /> : <Dumbbell size={17} aria-hidden="true" />} Log workout
      </button>
    </form>
  )
}

export default function TrainingGrounds() {
  const { profile } = useProfile()
  const { toast } = useRewards()
  const pathConfig = getPathConfig(profile.path)
  const data = useLoader(() => loadTrainingData(profile.id, profile.path), [profile.id, profile.path])
  const [planOverride, setPlanOverride] = useState(null)
  const planId = planOverride || data.data?.selectedPlanId || null
  const days = useLoader(() => loadPlanDays(planId), [planId], { enabled: Boolean(planId) })
  const [dayIndex, setDayIndex] = useState(0)
  const [checked, setChecked] = useState(() => new Set())

  const selectedDay = days.data?.[Math.min(dayIndex, (days.data?.length || 1) - 1)] || null

  const onSelectPlan = async (id) => {
    try {
      await selectWorkoutPlan(id)
      setPlanOverride(id)
      setDayIndex(0)
      setChecked(new Set())
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const toggle = (i) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  const grid = buildDayGrid(data.data?.logs || [])

  return (
    <div className="page">
      <PageHeader
        eyebrow={pathConfig.title}
        title={pathConfig.gymTitle}
        lede={pathConfig.gymLede}
        actions={
          <div className="streak-chip">
            <Flame size={18} aria-hidden="true" />
            <span>
              <strong className="tabular">{profile.currentStreak}</strong> day streak
            </span>
            <span className="fine-print tabular">best {profile.longestStreak}</span>
          </div>
        }
      />
      <AsyncBlock slice={data} rows={4}>
        {({ plans, logs }) => (
          <div className="gym-layout">
            <div className="gym-main">
              <Panel title="Plan">
                {plans.length === 0 ? (
                  <EmptyState icon={Dumbbell} title="No plans for this path yet">
                    Plans are added by the ZBXP team. You can still log workouts.
                  </EmptyState>
                ) : (
                  <div className="plan-list" role="radiogroup" aria-label="Workout plan">
                    {plans.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={planId === p.id}
                        className={cx('plan-card', planId === p.id && 'is-selected')}
                        onClick={() => planId !== p.id && onSelectPlan(p.id)}
                      >
                        <strong>{p.name}</strong>
                        {p.description ? <span className="fine-print">{p.description}</span> : null}
                      </button>
                    ))}
                  </div>
                )}
              </Panel>

              {planId ? (
                <Panel title="Session">
                  <AsyncBlock slice={days} rows={4}>
                    {(list) =>
                      list.length === 0 ? (
                        <EmptyState title="This plan has no days yet" />
                      ) : (
                        <>
                          <div className="tabs tabs--scroll" role="tablist" aria-label="Plan days">
                            {list.map((d, i) => (
                              <button
                                key={d.id}
                                type="button"
                                role="tab"
                                aria-selected={selectedDay?.id === d.id}
                                className={cx('tab', selectedDay?.id === d.id && 'is-active')}
                                onClick={() => {
                                  setDayIndex(i)
                                  setChecked(new Set())
                                }}
                              >
                                Day {d.dayNumber}
                              </button>
                            ))}
                          </div>
                          <DayDetail day={selectedDay} checked={checked} onToggle={toggle} />
                        </>
                      )
                    }
                  </AsyncBlock>
                </Panel>
              ) : null}
            </div>

            <aside className="gym-side">
              <Panel title="Log a workout">
                <LogForm
                  dayTitle={selectedDay?.title || ''}
                  exercisesDone={checked.size}
                  onLogged={() => {
                    setChecked(new Set())
                    data.reload()
                  }}
                />
              </Panel>
              <Panel title="Last 4 weeks" meta={`${logs.filter((l) => l.completed).length} completed sessions`}>
                <div className="day-grid" role="list" aria-label="Workout days, last 28 days">
                  {grid.map((d) => (
                    <span
                      key={d.key}
                      role="listitem"
                      className={cx('day-cell', `day-cell--${d.status}`, d.key === dayKey(new Date()) && 'is-today')}
                      title={`${d.date.toLocaleDateString()}: ${d.status === 'done' ? 'completed' : d.status === 'missed' ? 'missed' : 'no log'}${d.notes ? ` · ${d.notes}` : ''}`}
                      aria-label={`${d.date.toLocaleDateString()}: ${d.status === 'done' ? 'completed' : d.status === 'missed' ? 'missed' : 'no log'}`}
                    />
                  ))}
                </div>
                <div className="legend-row">
                  <span><i className="day-cell day-cell--done" aria-hidden="true" /> Completed</span>
                  <span><i className="day-cell day-cell--missed" aria-hidden="true" /> Missed</span>
                  <span><i className="day-cell day-cell--none" aria-hidden="true" /> No log</span>
                </div>
                {logs.length === 0 ? <Notice tone="info">Your first logged session starts the streak.</Notice> : null}
              </Panel>
            </aside>
          </div>
        )}
      </AsyncBlock>
    </div>
  )
}
