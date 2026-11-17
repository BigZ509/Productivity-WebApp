import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, Check, Flame, Play, ScrollText, Sparkles, Timer, UsersRound } from 'lucide-react'
import { useFocus, usePlayerData, useProfile } from '../../app/providers/contexts'
import { getPathConfig } from '../../config/pathConfig'
import { progressionSnapshot } from '../../lib/progression'
import { activityStreak, summarizeWeek } from '../../services/activity'
import { listQuestHistory, ACTIVE_QUEST_LIMIT } from '../../services/quests'
import { getGuildLeaderboard } from '../../services/guilds'
import { formatClock, relativeTime } from '../../lib/dates'
import { useLoader } from '../../hooks/useLoader'
import { useQuestActions } from '../quests/useQuestActions'
import {
  AsyncBlock,
  CategoryIcon,
  DifficultyPips,
  EmptyState,
  Meter,
  Panel,
  RankEmblem,
  SkeletonList,
  XpValue,
} from '../../components/ui'
import { WeekBars } from '../../components/WeekBars'

function greeting() {
  const h = new Date().getHours()
  if (h < 5) return 'Still up'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

const SOURCE_LABEL = {
  workout: 'Workout logged',
  focus: 'Focus session',
  reconciliation: 'Carried-over balance',
}

function NextUp({ pathConfig }) {
  const { activeQuests } = usePlayerData()
  const focus = useFocus()
  const navigate = useNavigate()
  const { complete, pending } = useQuestActions()

  if (focus.isActive) {
    return (
      <section className="next-up next-up--focus" aria-labelledby="next-up-title">
        <p className="eyebrow">In progress</p>
        <h2 id="next-up-title" className="next-up__title">
          {focus.state.quest?.title || 'Focus session'}
        </h2>
        <p className="next-up__meta tabular">
          <Timer size={16} aria-hidden="true" /> {formatClock(focus.remainingMs / 1000)} remaining
          {focus.state.status === 'paused' ? ' · paused' : ''}
        </p>
        <div className="row-actions">
          <Link to="/focus" className="btn btn--primary btn--lg">
            Return to focus <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </div>
      </section>
    )
  }

  if (activeQuests.status === 'loading' && !activeQuests.data) {
    return <div className="next-up"><SkeletonList rows={2} /></div>
  }

  const next = activeQuests.data?.[0]
  if (!next) {
    return (
      <section className="next-up" aria-labelledby="next-up-title">
        <p className="eyebrow">Next up</p>
        <h2 id="next-up-title" className="next-up__title">Choose your first {pathConfig.questNoun.toLowerCase()}</h2>
        <p className="next-up__meta">Pick one piece of real work for today. Accepting it puts it here.</p>
        <div className="row-actions">
          <Link to="/quests" className="btn btn--primary btn--lg">
            Open {pathConfig.boardTitle} <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </div>
      </section>
    )
  }

  const q = next.quest
  return (
    <section className="next-up" aria-labelledby="next-up-title">
      <p className="eyebrow">Continue mission</p>
      <div className="next-up__head">
        <CategoryIcon category={q.category} size={20} />
        <h2 id="next-up-title" className="next-up__title">{q.title}</h2>
      </div>
      {q.description ? <p className="next-up__desc">{q.description}</p> : null}
      <div className="next-up__meta">
        <DifficultyPips difficulty={q.difficulty} />
        <span className="reward-tag"><XpValue value={q.xpReward} prefix="+" /></span>
      </div>
      <div className="row-actions">
        <button
          type="button"
          className="btn btn--primary btn--lg"
          onClick={() => navigate('/focus', { state: { activeQuestId: next.id } })}
        >
          <Play size={18} aria-hidden="true" /> Start focus
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--lg"
          disabled={pending[`complete:${next.id}`]}
          onClick={() => complete(next)}
        >
          <Check size={18} aria-hidden="true" /> Mark complete
        </button>
      </div>
    </section>
  )
}

function ActiveMissions({ pathConfig }) {
  const { activeQuests } = usePlayerData()
  const navigate = useNavigate()
  const { complete, pending } = useQuestActions()
  const count = activeQuests.data?.length || 0

  return (
    <Panel
      title={`Active ${pathConfig.questNounPlural.toLowerCase()}`}
      meta={`${count} of ${ACTIVE_QUEST_LIMIT} slots in use`}
      actions={
        <Link to="/quests" className="btn btn--quiet btn--sm">
          Board <ArrowRight size={15} aria-hidden="true" />
        </Link>
      }
    >
      <AsyncBlock slice={activeQuests} rows={3}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState icon={ScrollText} title="No active quests">
              Accepted quests appear here until you complete them.
            </EmptyState>
          ) : (
            <ul className="mission-list">
              {items.map((item) => (
                <li key={item.id} className="mission-row">
                  <CategoryIcon category={item.quest.category} />
                  <div className="mission-row__text">
                    <span className="mission-row__title">{item.quest.title}</span>
                    <span className="mission-row__meta">
                      Accepted {relativeTime(item.selectedAt)} · <XpValue value={item.quest.xpReward} prefix="+" />
                    </span>
                  </div>
                  <div className="mission-row__actions">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Focus on ${item.quest.title}`}
                      title="Start focus"
                      onClick={() => navigate('/focus', { state: { activeQuestId: item.id } })}
                    >
                      <Timer size={17} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn icon-btn--accent"
                      aria-label={`Complete ${item.quest.title}`}
                      title="Complete"
                      disabled={pending[`complete:${item.id}`]}
                      onClick={() => complete(item)}
                    >
                      <Check size={17} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </AsyncBlock>
    </Panel>
  )
}

function RecentRewards({ userId }) {
  const { xpEvents } = usePlayerData()
  const history = useLoader(() => listQuestHistory(userId, { limit: 20 }), [userId, xpEvents.data])
  const titles = new Map((history.data || []).map((h) => [h.id, h.quest?.title]))

  return (
    <Panel title="Latest rewards">
      <AsyncBlock slice={xpEvents} rows={3}>
        {(events) =>
          events.length === 0 ? (
            <EmptyState icon={Sparkles} title="No rewards yet">
              Complete a quest, a focus session or a workout to earn XP.
            </EmptyState>
          ) : (
            <ul className="reward-list">
              {events.slice(0, 6).map((e) => (
                <li key={e.id} className="reward-row">
                  <span className={`reward-row__dot reward-row__dot--${e.sourceType}`} aria-hidden="true" />
                  <span className="reward-row__label">
                    {e.sourceType === 'quest' ? titles.get(e.sourceId) || 'Quest completed' : SOURCE_LABEL[e.sourceType] || e.sourceType}
                  </span>
                  <span className="reward-row__when">{relativeTime(e.createdAt)}</span>
                  <XpValue value={e.amount} prefix="+" />
                </li>
              ))}
            </ul>
          )
        }
      </AsyncBlock>
    </Panel>
  )
}

function CharacterSummary({ profile, streak }) {
  const snap = progressionSnapshot(profile.xp, profile.path)
  return (
    <Panel className="char-summary" aria-label="Character summary">
      <div className="char-summary__head">
        <RankEmblem rank={snap.rankInfo.rank} size={64} />
        <div>
          <p className="eyebrow">{snap.rankInfo.title}</p>
          <p className="char-summary__level">
            Level <span className="tabular">{snap.level}</span>
          </p>
          <p className="muted tabular">{snap.xp.toLocaleString()} total XP</p>
        </div>
      </div>
      <div className="stack-sm">
        <div className="meter-label">
          <span>Next level</span>
          <span className="tabular">
            {snap.into} / {snap.needed} XP
          </span>
        </div>
        <Meter value={snap.into} max={snap.needed} label="Progress to next level" valueText={`${snap.remaining} XP to level ${snap.level + 1}`} />
        {snap.rankInfo.next ? (
          <p className="fine-print tabular">
            {snap.rankInfo.remaining.toLocaleString()} XP to {snap.rankInfo.next.title}
          </p>
        ) : (
          <p className="fine-print">Highest rank reached.</p>
        )}
      </div>
      <div className="streak-line" title="Consecutive days with at least one quest, workout or focus session. Today counts once you earn XP.">
        <Flame size={18} aria-hidden="true" />
        <span>
          <strong className="tabular">{streak.streak}</strong>-day activity streak
        </span>
        <span className="fine-print">{streak.activeToday ? 'Today counted' : 'Earn XP today to extend'}</span>
      </div>
    </Panel>
  )
}

function WeeklyProgress({ week }) {
  return (
    <Panel title="This week" meta="Monday to Sunday, from your recorded XP">
      <WeekBars byDay={week.byDay} />
      <dl className="stat-row">
        <div className="stat">
          <dt>XP</dt>
          <dd className="tabular">{week.xp.toLocaleString()}</dd>
        </div>
        <div className="stat">
          <dt>Quests</dt>
          <dd className="tabular">{week.quests}</dd>
        </div>
        <div className="stat">
          <dt>Focus</dt>
          <dd className="tabular">{week.focusSessions}</dd>
        </div>
        <div className="stat">
          <dt>Active days</dt>
          <dd className="tabular">{week.activeDays}/7</dd>
        </div>
      </dl>
    </Panel>
  )
}

function GuildSnapshot() {
  const { guilds } = usePlayerData()
  const first = guilds.data?.[0]
  const board = useLoader(() => getGuildLeaderboard(first.id, 'weekly'), [first?.id], { enabled: Boolean(first?.id) })
  const me = board.data?.find((r) => r.isSelf)

  return (
    <Panel
      title="Guild"
      actions={
        <Link to="/guild" className="btn btn--quiet btn--sm">
          Hall <ArrowRight size={15} aria-hidden="true" />
        </Link>
      }
    >
      <AsyncBlock slice={guilds} rows={2}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              icon={UsersRound}
              title="Not in a guild"
              action={
                <Link to="/guild" className="btn btn--ghost btn--sm">
                  Find a guild
                </Link>
              }
            >
              Join friends to compare weekly XP.
            </EmptyState>
          ) : (
            <div className="guild-snap">
              <p className="guild-snap__name">{first.name}</p>
              <p className="muted">{first.memberCount} members</p>
              {board.status === 'ready' && me ? (
                <p className="guild-snap__standing">
                  You’re <strong className="tabular">#{me.standing}</strong> this week with{' '}
                  <XpValue value={me.xp} />
                </p>
              ) : board.status === 'error' ? (
                <p className="fine-print">{board.error.message}</p>
              ) : (
                <SkeletonList rows={1} />
              )}
            </div>
          )
        }
      </AsyncBlock>
    </Panel>
  )
}

export default function CommandCenter() {
  const { profile } = useProfile()
  const { xpEvents } = usePlayerData()
  const pathConfig = getPathConfig(profile.path)
  const events = xpEvents.data || []
  const week = summarizeWeek(events)
  const streak = activityStreak(events)

  return (
    <div className="dashboard">
      <header className="dash-hero">
        <p className="eyebrow">{pathConfig.title} · {pathConfig.welcome}</p>
        <h1 className="page-title">
          {greeting()}, {profile.displayName}
        </h1>
      </header>

      <div className="dash-grid">
        <div className="dash-main">
          <NextUp pathConfig={pathConfig} />
          <ActiveMissions pathConfig={pathConfig} />
          <RecentRewards userId={profile.id} />
        </div>
        <aside className="dash-rail" aria-label="Progress">
          <CharacterSummary profile={profile} streak={streak} />
          <WeeklyProgress week={week} />
          <GuildSnapshot />
        </aside>
      </div>
    </div>
  )
}
