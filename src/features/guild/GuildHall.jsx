import { useState } from 'react'
import { Copy, Crown, DoorOpen, Globe2, KeyRound, Lock, Plus, Search, Trophy, UsersRound } from 'lucide-react'
import { usePlayerData, useProfile, useRewards } from '../../app/providers/contexts'
import { getPathConfig } from '../../config/pathConfig'
import {
  createGuild,
  getGuildLeaderboard,
  joinGuildByCode,
  joinPublicGuild,
  leaveGuild,
  listPublicGuilds,
} from '../../services/guilds'
import { useLoader } from '../../hooks/useLoader'
import { cx } from '../../lib/cx'
import { AsyncBlock, EmptyState, PageHeader, Panel, Spinner, XpValue } from '../../components/ui'

function Leaderboard({ guildId }) {
  const [timeframe, setTimeframe] = useState('weekly')
  const board = useLoader(() => getGuildLeaderboard(guildId, timeframe), [guildId, timeframe])

  return (
    <Panel
      title="Leaderboard"
      meta={timeframe === 'weekly' ? 'XP earned since Monday 00:00 UTC.' : 'Total XP from the reward ledger.'}
      actions={
        <div className="segmented segmented--sm" role="tablist" aria-label="Timeframe">
          {[
            ['weekly', 'This week'],
            ['all_time', 'All time'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={timeframe === id}
              className={cx('segmented__btn', timeframe === id && 'is-active')}
              onClick={() => setTimeframe(id)}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      <AsyncBlock slice={board} rows={4}>
        {(rows) => (
          <ol className="board">
            {rows.map((r, i) => (
              <li key={`${r.displayName}-${i}`} className={cx('board-row', r.isSelf && 'is-self', r.standing <= 3 && r.xp > 0 && `is-top${r.standing}`)}>
                <span className="board-row__pos tabular">{r.standing}</span>
                <span className="board-row__name">
                  {r.displayName}
                  {r.isSelf ? <span className="you-tag">You</span> : null}
                  {r.role === 'owner' ? (
                    <span className="role-tag" title="Guild owner">
                      <Crown size={12} aria-hidden="true" /> Owner
                    </span>
                  ) : null}
                </span>
                <XpValue value={r.xp} />
              </li>
            ))}
          </ol>
        )}
      </AsyncBlock>
    </Panel>
  )
}

function GuildDetail({ guild, onLeft }) {
  const { toast } = useRewards()
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [busy, setBusy] = useState(false)

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(guild.inviteCode)
      toast('Invite code copied.', 'success')
    } catch {
      toast(`Invite code: ${guild.inviteCode}`, 'info')
    }
  }

  const onLeave = async () => {
    setBusy(true)
    try {
      await leaveGuild(guild.id)
      toast(`You left ${guild.name}.`, 'info')
      onLeft()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
      setConfirmLeave(false)
    }
  }

  return (
    <div className="guild-detail">
      <section className="guild-banner">
        <div className="guild-banner__crest" aria-hidden="true">
          {guild.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="guild-banner__body">
          <p className="eyebrow">
            {guild.visibility === 'private' ? (
              <>
                <Lock size={12} aria-hidden="true" /> Private guild
              </>
            ) : (
              <>
                <Globe2 size={12} aria-hidden="true" /> Public guild
              </>
            )}{' '}
            · {guild.role === 'owner' ? 'You lead this guild' : 'Member'}
          </p>
          <h2 className="guild-banner__name">{guild.name}</h2>
          {guild.description ? <p className="muted">{guild.description}</p> : null}
          <p className="fine-print tabular">
            {guild.memberCount} member{guild.memberCount === 1 ? '' : 's'} · joined{' '}
            {new Date(guild.joinedAt).toLocaleDateString()}
          </p>
        </div>
        <div className="guild-banner__actions">
          <button type="button" className="code-btn" onClick={copyCode} aria-label={`Copy invite code ${guild.inviteCode}`}>
            <KeyRound size={14} aria-hidden="true" />
            <span className="tabular">{guild.inviteCode}</span>
            <Copy size={14} aria-hidden="true" />
          </button>
          {confirmLeave ? (
            <span className="confirm-inline">
              <button type="button" className="btn btn--danger btn--sm" onClick={onLeave} disabled={busy}>
                {busy ? <Spinner label="Leaving" /> : null} Leave guild
              </button>
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => setConfirmLeave(false)}>
                Stay
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setConfirmLeave(true)}>
              <DoorOpen size={15} aria-hidden="true" /> Leave
            </button>
          )}
        </div>
      </section>
      <Leaderboard guildId={guild.id} />
    </div>
  )
}

function JoinCreate({ onJoined }) {
  const { toast } = useRewards()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState('public')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState('')
  const directory = useLoader(() => listPublicGuilds(search), [search])

  const run = async (key, fn) => {
    setBusy(key)
    try {
      await fn()
    } catch (err) {
      toast(err.message, 'error', { duration: 6000 })
    } finally {
      setBusy('')
    }
  }

  const onJoinCode = (e) => {
    e.preventDefault()
    run('code', async () => {
      const res = await joinGuildByCode(code)
      toast(res.joined ? `Welcome to ${res.name}.` : `You’re already in ${res.name}.`, 'success')
      setCode('')
      onJoined(res.id)
    })
  }

  const onCreate = (e) => {
    e.preventDefault()
    run('create', async () => {
      const res = await createGuild({ name: name.trim(), description: description.trim(), visibility })
      toast(`${name.trim()} founded. Share code ${res.inviteCode} to invite members.`, 'success', { duration: 7000 })
      setName('')
      setDescription('')
      onJoined(res.id)
    })
  }

  return (
    <div className="guild-actions">
      <Panel title="Join with an invite code">
        <form className="inline-form" onSubmit={onJoinCode}>
          <label className="sr-only" htmlFor="invite-code">
            Invite code
          </label>
          <input
            id="invite-code"
            className="input input--code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="e.g. 7F3A9C21"
            maxLength={12}
            autoComplete="off"
            required
          />
          <button type="submit" className="btn btn--primary" disabled={busy === 'code' || code.trim().length < 6}>
            {busy === 'code' ? <Spinner label="Joining" /> : null} Join
          </button>
        </form>
      </Panel>

      <Panel title="Found a guild">
        <form className="form" onSubmit={onCreate}>
          <label className="field">
            <span className="field__label">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} minLength={3} maxLength={40} required />
          </label>
          <label className="field">
            <span className="field__label">Description (optional)</span>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} />
          </label>
          <div className="chip-row" role="radiogroup" aria-label="Visibility">
            {[
              ['public', 'Public: listed in the directory'],
              ['private', 'Private: invite code only'],
            ].map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={visibility === v}
                className={cx('chip', visibility === v && 'is-active')}
                onClick={() => setVisibility(v)}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="submit" className="btn btn--ghost" disabled={busy === 'create' || name.trim().length < 3}>
            {busy === 'create' ? <Spinner label="Creating" /> : <Plus size={16} aria-hidden="true" />} Create guild
          </button>
        </form>
      </Panel>

      <Panel title="Public guilds">
        <label className="search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search guilds</span>
          <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name" />
        </label>
        <AsyncBlock slice={directory} rows={3}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState icon={UsersRound} title="No public guilds found">
                Found the first one above.
              </EmptyState>
            ) : (
              <ul className="directory">
                {list.map((g) => (
                  <li key={g.id} className="directory-row">
                    <div>
                      <strong>{g.name}</strong>
                      {g.description ? <span className="fine-print">{g.description}</span> : null}
                      <span className="fine-print tabular">
                        {g.memberCount}/{g.maxMembers} members
                      </span>
                    </div>
                    {g.isMember ? (
                      <span className="status-tag status-tag--active">Member</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busy === g.id || g.memberCount >= g.maxMembers}
                        onClick={() =>
                          run(g.id, async () => {
                            const res = await joinPublicGuild(g.id)
                            toast(`Welcome to ${res.name}.`, 'success')
                            onJoined(res.id)
                          })
                        }
                      >
                        {busy === g.id ? <Spinner label="Joining" /> : null} Join
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )
          }
        </AsyncBlock>
      </Panel>
    </div>
  )
}

export default function GuildHall() {
  const { profile } = useProfile()
  const { guilds } = usePlayerData()
  const pathConfig = getPathConfig(profile.path)
  const [selectedId, setSelectedId] = useState(null)
  const list = guilds.data || []
  const selected = list.find((g) => g.id === selectedId) || list[0] || null

  const onJoined = async (id) => {
    await guilds.reload()
    setSelectedId(id)
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow={pathConfig.title}
        title={pathConfig.guildTitle}
        lede="Compete on weekly XP with people you trust. Every number here comes from the same reward ledger as your profile."
      />
      <AsyncBlock slice={guilds} rows={4}>
        {() => (
          <div className="guild-layout">
            <div className="guild-main">
              {list.length > 1 ? (
                <div className="chip-row" role="tablist" aria-label="Your guilds">
                  {list.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      role="tab"
                      aria-selected={selected?.id === g.id}
                      className={cx('chip', selected?.id === g.id && 'is-active')}
                      onClick={() => setSelectedId(g.id)}
                    >
                      {g.name}
                    </button>
                  ))}
                </div>
              ) : null}
              {selected ? (
                <GuildDetail key={selected.id} guild={selected} onLeft={() => onJoined(null)} />
              ) : (
                <EmptyState icon={Trophy} title="You’re not in a guild yet">
                  Join with an invite code, pick a public guild, or found your own. Guildmates see your display name,
                  role and XP, never your email.
                </EmptyState>
              )}
            </div>
            <aside className="guild-side">
              <JoinCreate onJoined={onJoined} />
            </aside>
          </div>
        )}
      </AsyncBlock>
    </div>
  )
}
