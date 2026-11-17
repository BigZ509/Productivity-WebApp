import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Clock3, History, Play, Plus, ScrollText, X } from 'lucide-react'
import { usePlayerData, useProfile } from '../../app/providers/contexts'
import { CATEGORY_META, getPathConfig } from '../../config/pathConfig'
import { ACTIVE_QUEST_LIMIT, QUEST_CATEGORIES, listAvailableQuests, listQuestHistory } from '../../services/quests'
import { useLoader } from '../../hooks/useLoader'
import { useQuestActions } from './useQuestActions'
import { relativeTime } from '../../lib/dates'
import { cx } from '../../lib/cx'
import {
  AsyncBlock,
  CategoryIcon,
  DifficultyPips,
  EmptyState,
  Meter,
  PageHeader,
  Panel,
  Spinner,
  XpValue,
} from '../../components/ui'

function cooldownUntil(history, quest) {
  const last = history.find((h) => h.questId === quest.id)
  if (!last?.completedAt) return null
  const until = new Date(last.completedAt).getTime() + quest.cooldownHours * 3600 * 1000
  return until > Date.now() ? until : null
}

function AvailableCard({ quest, state, onAccept, busy, justAccepted }) {
  return (
    <li className={cx('quest-card', `quest-card--${quest.category}`, justAccepted && 'is-accepted')}>
      <div className="quest-card__top">
        <CategoryIcon category={quest.category} />
        <div className="quest-card__heading">
          <h3 className="quest-card__title">{quest.title}</h3>
          <DifficultyPips difficulty={quest.difficulty} />
        </div>
        <span className="reward-tag">
          <XpValue value={quest.xpReward} prefix="+" />
        </span>
      </div>
      {quest.description ? <p className="quest-card__desc">{quest.description}</p> : null}
      {quest.flavor ? <p className="quest-card__flavor">“{quest.flavor}”</p> : null}
      <div className="quest-card__foot">
        {state.kind === 'active' ? (
          <span className="status-tag status-tag--active">
            <Check size={14} aria-hidden="true" /> Active
          </span>
        ) : state.kind === 'cooldown' ? (
          <span className="status-tag" title="Repeatable quests have a cooldown after completion.">
            <Clock3 size={14} aria-hidden="true" /> Again {relativeTime(state.until)}
          </span>
        ) : (
          <span className="fine-print">Repeatable · {quest.cooldownHours}h cooldown</span>
        )}
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={busy || state.kind !== 'available' || state.full}
          onClick={() => onAccept(quest)}
          title={state.full && state.kind === 'available' ? `You can hold ${ACTIVE_QUEST_LIMIT} active quests at a time.` : undefined}
        >
          {busy ? <Spinner label="Accepting" /> : <Plus size={16} aria-hidden="true" />}
          {state.kind === 'active' ? 'Accepted' : 'Accept'}
        </button>
      </div>
    </li>
  )
}

function ActiveCard({ item, pending, onComplete, onAbandon, onFocus }) {
  const [note, setNote] = useState('')
  const [showNote, setShowNote] = useState(false)
  const [confirmAbandon, setConfirmAbandon] = useState(false)
  const q = item.quest
  const completing = pending[`complete:${item.id}`]

  return (
    <li className={cx('active-card', `quest-card--${q.category}`)}>
      <div className="quest-card__top">
        <CategoryIcon category={q.category} />
        <div className="quest-card__heading">
          <h3 className="quest-card__title">{q.title}</h3>
          <span className="fine-print">Accepted {relativeTime(item.selectedAt)}</span>
        </div>
        <span className="reward-tag">
          <XpValue value={q.xpReward} prefix="+" />
        </span>
      </div>
      {showNote ? (
        <label className="field">
          <span className="field__label">Completion note (optional)</span>
          <textarea
            className="input textarea"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What did you ship, learn or finish?"
          />
        </label>
      ) : null}
      <div className="active-card__actions">
        <button type="button" className="btn btn--primary btn--sm" disabled={completing} onClick={() => onComplete(item, note)}>
          {completing ? <Spinner label="Completing" /> : <Check size={16} aria-hidden="true" />} Complete
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onFocus(item)}>
          <Play size={15} aria-hidden="true" /> Focus
        </button>
        {!showNote ? (
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => setShowNote(true)}>
            Add note
          </button>
        ) : null}
        <span className="spacer" />
        {confirmAbandon ? (
          <span className="confirm-inline">
            <span className="fine-print">Abandon? No XP.</span>
            <button type="button" className="btn btn--danger btn--sm" onClick={() => onAbandon(item)}>
              Abandon
            </button>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setConfirmAbandon(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Abandon ${q.title}`}
            title="Abandon"
            onClick={() => setConfirmAbandon(true)}
          >
            <X size={16} />
          </button>
        )}
      </div>
    </li>
  )
}

export default function QuestBoard() {
  const { profile } = useProfile()
  const { activeQuests } = usePlayerData()
  const pathConfig = getPathConfig(profile.path)
  const navigate = useNavigate()
  const { accept, complete, abandon, pending } = useQuestActions()
  const [category, setCategory] = useState('all')
  const [tab, setTab] = useState('board')
  const [justAccepted, setJustAccepted] = useState(null)

  const available = useLoader(() => listAvailableQuests(profile.path), [profile.path])
  const history = useLoader(() => listQuestHistory(profile.id, { limit: 50 }), [profile.id, activeQuests.data])

  const active = useMemo(() => activeQuests.data || [], [activeQuests.data])
  const activeByQuest = new Map(active.map((a) => [a.quest?.id, a]))
  const full = active.length >= ACTIVE_QUEST_LIMIT
  const filtered = (available.data || []).filter((q) => category === 'all' || q.category === category)

  const onAccept = async (quest) => {
    const res = await accept(quest)
    if (res && !res.alreadyActive) {
      setJustAccepted(quest.id)
      setTimeout(() => setJustAccepted(null), 1200)
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow={pathConfig.title}
        title={pathConfig.boardTitle}
        lede={pathConfig.boardLede}
        actions={
          <div className="slots" aria-label={`${active.length} of ${ACTIVE_QUEST_LIMIT} active slots used`}>
            <span className="fine-print">Active slots</span>
            <span className="tabular slots__count">
              {active.length}/{ACTIVE_QUEST_LIMIT}
            </span>
            <Meter value={active.length} max={ACTIVE_QUEST_LIMIT} size="xs" label="Active quest slots" />
          </div>
        }
      />

      <div className="tabs" role="tablist" aria-label="Quest views">
        {[
          ['board', 'Board'],
          ['active', `Active (${active.length})`],
          ['history', 'History'],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={cx('tab', tab === id && 'is-active')}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'board' ? (
        <div className="quest-layout">
          <section aria-label="Available quests">
            <div className="chip-row" role="group" aria-label="Filter by category">
              {['all', ...QUEST_CATEGORIES].map((c) => (
                <button
                  key={c}
                  type="button"
                  className={cx('chip', category === c && 'is-active')}
                  aria-pressed={category === c}
                  onClick={() => setCategory(c)}
                >
                  {c === 'all' ? 'All' : CATEGORY_META[c]?.label || c}
                </button>
              ))}
            </div>
            <AsyncBlock slice={available} rows={5} errorTitle="Couldn’t load the board">
              {() =>
                filtered.length === 0 ? (
                  <EmptyState icon={ScrollText} title="No quests in this category">
                    Try another category.
                  </EmptyState>
                ) : (
                  <ul className="quest-grid">
                    {filtered.map((quest) => {
                      const activeEntry = activeByQuest.get(quest.id)
                      const until = activeEntry ? null : cooldownUntil(history.data || [], quest)
                      const state = activeEntry
                        ? { kind: 'active' }
                        : until
                          ? { kind: 'cooldown', until }
                          : { kind: 'available', full }
                      return (
                        <AvailableCard
                          key={quest.id}
                          quest={quest}
                          state={state}
                          busy={pending[`accept:${quest.id}`]}
                          justAccepted={justAccepted === quest.id}
                          onAccept={onAccept}
                        />
                      )
                    })}
                  </ul>
                )
              }
            </AsyncBlock>
          </section>
          <aside className="quest-side" aria-label="Active quests">
            <Panel title="Active" meta={full ? 'All slots full. Complete or abandon one to accept more.' : 'Complete these to claim XP.'}>
              <AsyncBlock slice={activeQuests} rows={2}>
                {(items) =>
                  items.length === 0 ? (
                    <EmptyState title="Nothing active">Accept a quest to start.</EmptyState>
                  ) : (
                    <ul className="active-list">
                      {items.map((item) => (
                        <ActiveCard
                          key={item.id}
                          item={item}
                          pending={pending}
                          onComplete={(it, note) => complete(it, { note })}
                          onAbandon={abandon}
                          onFocus={(it) => navigate('/focus', { state: { activeQuestId: it.id } })}
                        />
                      ))}
                    </ul>
                  )
                }
              </AsyncBlock>
            </Panel>
          </aside>
        </div>
      ) : null}

      {tab === 'active' ? (
        <AsyncBlock slice={activeQuests} rows={3}>
          {(items) =>
            items.length === 0 ? (
              <EmptyState
                icon={ScrollText}
                title="No active quests"
                action={
                  <button type="button" className="btn btn--primary" onClick={() => setTab('board')}>
                    Browse the board
                  </button>
                }
              >
                You can hold up to {ACTIVE_QUEST_LIMIT} at a time.
              </EmptyState>
            ) : (
              <ul className="active-list active-list--wide">
                {items.map((item) => (
                  <ActiveCard
                    key={item.id}
                    item={item}
                    pending={pending}
                    onComplete={(it, note) => complete(it, { note })}
                    onAbandon={abandon}
                    onFocus={(it) => navigate('/focus', { state: { activeQuestId: it.id } })}
                  />
                ))}
              </ul>
            )
          }
        </AsyncBlock>
      ) : null}

      {tab === 'history' ? (
        <AsyncBlock slice={history} rows={4}>
          {(items) =>
            items.length === 0 ? (
              <EmptyState icon={History} title="No completed quests yet">
                Completed quests and the XP they earned show up here.
              </EmptyState>
            ) : (
              <ol className="history-list">
                {items.map((h) => (
                  <li key={h.id} className="history-row">
                    <CategoryIcon category={h.quest?.category} />
                    <div className="history-row__text">
                      <span className="history-row__title">{h.quest?.title}</span>
                      <span className="fine-print">
                        {new Date(h.completedAt).toLocaleString(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </span>
                      {h.note ? <span className="history-row__note">“{h.note}”</span> : null}
                    </div>
                    <XpValue value={h.xpAwarded} prefix="+" />
                  </li>
                ))}
              </ol>
            )
          }
        </AsyncBlock>
      ) : null}
    </div>
  )
}
