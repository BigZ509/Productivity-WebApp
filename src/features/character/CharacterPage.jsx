import { useState } from 'react'
import { Award, Check, Lock, PencilLine } from 'lucide-react'
import { usePlayerData, useProfile, useRewards } from '../../app/providers/contexts'
import { CATEGORY_META, PATH_CONFIG, PATH_KEYS, getPathConfig } from '../../config/pathConfig'
import { RANK_TIERS, progressionSnapshot } from '../../lib/progression'
import { countCompletedWorkouts, countCompletionsByCategory, listFocusSessions } from '../../services/activity'
import { QUEST_CATEGORIES } from '../../services/quests'
import { setIdentity } from '../../services/profile'
import { useLoader } from '../../hooks/useLoader'
import { buildAchievements, masteryFor } from './milestones'
import { cx } from '../../lib/cx'
import { AsyncBlock, CategoryIcon, Meter, Notice, Panel, RankEmblem, Spinner } from '../../components/ui'

function IdentityEditor({ profile, onClose }) {
  const { reload } = useProfile()
  const { toast } = useRewards()
  const [name, setName] = useState(profile.displayName)
  const [path, setPath] = useState(profile.path)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const onSubmit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await setIdentity({ displayName: name.trim(), path })
      await reload()
      toast('Character updated.', 'success')
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <form className="identity-editor" onSubmit={onSubmit}>
      <label className="field">
        <span className="field__label">Display name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={24} required />
      </label>
      <fieldset className="field">
        <legend className="field__label">Path</legend>
        <div className="chip-row">
          {PATH_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={cx('chip', path === k && 'is-active')}
              aria-pressed={path === k}
              onClick={() => setPath(k)}
            >
              {PATH_CONFIG[k].title}
            </button>
          ))}
        </div>
        {path !== profile.path ? (
          <span className="field__hint">Switching paths changes your quest pool and theme. XP, rank and history are kept.</span>
        ) : null}
      </fieldset>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="row-actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>
          {busy ? <Spinner label="Saving" /> : null} Save
        </button>
        <button type="button" className="btn btn--quiet btn--sm" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}

export default function CharacterPage() {
  const { profile } = useProfile()
  const { guilds } = usePlayerData()
  const pathConfig = getPathConfig(profile.path)
  const snap = progressionSnapshot(profile.xp, profile.path)
  const [editing, setEditing] = useState(false)

  const stats = useLoader(async () => {
    const [byCategory, focus, workouts] = await Promise.all([
      countCompletionsByCategory(profile.id),
      listFocusSessions(profile.id, { limit: 1000 }),
      countCompletedWorkouts(profile.id),
    ])
    const focusMinutes = Math.round(focus.reduce((sum, s) => sum + Number(s.focused_seconds || 0), 0) / 60)
    return {
      byCategory,
      questsCompleted: Object.values(byCategory).reduce((a, b) => a + b, 0),
      focusSessions: focus.length,
      focusMinutes,
      workouts,
    }
  }, [profile.id, profile.xp])

  return (
    <div className="page character-page">
      <section className="char-hero" aria-labelledby="char-name">
        <div className="char-hero__emblem">
          <RankEmblem rank={snap.rankInfo.rank} size={132} />
        </div>
        <div className="char-hero__body">
          <p className="eyebrow">
            {pathConfig.characterTitle} · {pathConfig.title}
          </p>
          <h1 id="char-name" className="char-hero__name">
            {profile.displayName}
          </h1>
          <p className="char-hero__rank">{snap.rankInfo.title}</p>
          <dl className="char-hero__stats">
            <div>
              <dt>Level</dt>
              <dd className="tabular">{snap.level}</dd>
            </div>
            <div>
              <dt>Total XP</dt>
              <dd className="tabular">{snap.xp.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Workout streak</dt>
              <dd className="tabular">{profile.currentStreak}d</dd>
            </div>
          </dl>
          <div className="stack-sm">
            <div className="meter-label">
              <span>Level {snap.level + 1}</span>
              <span className="tabular">{snap.remaining} XP to go</span>
            </div>
            <Meter value={snap.into} max={snap.needed} label="Progress to next level" />
            {snap.rankInfo.next ? (
              <>
                <div className="meter-label">
                  <span>{snap.rankInfo.next.title}</span>
                  <span className="tabular">{snap.rankInfo.remaining.toLocaleString()} XP to go</span>
                </div>
                <Meter value={snap.rankInfo.ratio} max={1} tone="gold" label="Progress to next rank" />
              </>
            ) : null}
          </div>
          {editing ? (
            <IdentityEditor profile={profile} onClose={() => setEditing(false)} />
          ) : (
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setEditing(true)}>
              <PencilLine size={15} aria-hidden="true" /> Edit name or path
            </button>
          )}
        </div>
      </section>

      <Panel title="Rank ladder" meta="Ranks are earned from total XP. Every tier is a milestone, not a purchase.">
        <ol className="rank-ladder">
          {RANK_TIERS.map((tier, i) => {
            const reached = snap.xp >= tier.min
            const current = i === snap.rankInfo.index
            return (
              <li key={tier.rank} className={cx('rank-step', reached && 'is-reached', current && 'is-current')}>
                <RankEmblem rank={tier.rank} size={44} label={`Rank ${tier.rank}`} />
                <div className="rank-step__text">
                  <strong>{profile.path === 'HEAVENLY_DEMON' ? tier.demon : tier.hunter}</strong>
                  <span className="fine-print tabular">{tier.min.toLocaleString()} XP</span>
                </div>
                <span className="rank-step__state" aria-label={reached ? 'Reached' : 'Locked'}>
                  {current ? 'Current' : reached ? <Check size={16} /> : <Lock size={15} />}
                </span>
              </li>
            )
          })}
        </ol>
      </Panel>

      <div className="two-col">
        <Panel title="Category mastery" meta="Based on completed quests in each category.">
          <AsyncBlock slice={stats} rows={4}>
            {(data) => (
              <ul className="mastery-list">
                {QUEST_CATEGORIES.map((cat) => {
                  const m = masteryFor(data.byCategory[cat] || 0)
                  return (
                    <li key={cat} className="mastery-row">
                      <CategoryIcon category={cat} />
                      <div className="mastery-row__body">
                        <div className="meter-label">
                          <span>
                            <strong>{CATEGORY_META[cat].label}</strong> · {m.tier}
                          </span>
                          <span className="tabular fine-print">
                            {m.count}
                            {m.nextAt ? ` / ${m.nextAt}` : ''} quests
                          </span>
                        </div>
                        <Meter value={m.ratio} max={1} size="sm" label={`${CATEGORY_META[cat].label} mastery`} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </AsyncBlock>
        </Panel>

        <Panel title="Record" meta="All-time, from your saved history.">
          <AsyncBlock slice={stats} rows={3}>
            {(data) => (
              <dl className="stat-grid">
                <div className="stat">
                  <dt>Quests completed</dt>
                  <dd className="tabular">{data.questsCompleted}</dd>
                </div>
                <div className="stat">
                  <dt>Focus sessions</dt>
                  <dd className="tabular">{data.focusSessions}</dd>
                </div>
                <div className="stat">
                  <dt>Focused hours</dt>
                  <dd className="tabular">{(data.focusMinutes / 60).toFixed(1)}</dd>
                </div>
                <div className="stat">
                  <dt>Workouts</dt>
                  <dd className="tabular">{data.workouts}</dd>
                </div>
                <div className="stat">
                  <dt>Longest workout streak</dt>
                  <dd className="tabular">{profile.longestStreak}d</dd>
                </div>
                <div className="stat">
                  <dt>Guilds</dt>
                  <dd className="tabular">{guilds.data?.length ?? '–'}</dd>
                </div>
              </dl>
            )}
          </AsyncBlock>
        </Panel>
      </div>

      <Panel title="Achievements" meta="Earned automatically from your recorded activity.">
        <AsyncBlock slice={stats} rows={3}>
          {(data) => {
            const list = buildAchievements({
              level: snap.level,
              questsCompleted: data.questsCompleted,
              focusMinutes: data.focusMinutes,
              focusSessions: data.focusSessions,
              workouts: data.workouts,
              longestStreak: profile.longestStreak,
              guildCount: guilds.data?.length || 0,
            })
            const earned = list.filter((a) => a.earned).length
            return (
              <>
                <p className="fine-print tabular">
                  {earned} of {list.length} earned
                </p>
                <ul className="achievement-grid">
                  {list.map((a) => (
                    <li key={a.id} className={cx('achievement', a.earned && 'is-earned')}>
                      <span className="achievement__icon" aria-hidden="true">
                        {a.earned ? <Award size={20} /> : <Lock size={18} />}
                      </span>
                      <div>
                        <strong className="achievement__title">{a.title}</strong>
                        <span className="achievement__desc">{a.desc}</span>
                        {!a.earned ? (
                          <span className="achievement__progress tabular">
                            {a.shown} / {a.goal}
                            {a.unit ? ` ${a.unit}` : ''}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )
          }}
        </AsyncBlock>
      </Panel>
    </div>
  )
}
