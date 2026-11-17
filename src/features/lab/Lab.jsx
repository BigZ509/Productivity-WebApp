import { useState } from 'react'
import { Check, FlaskConical, Trash2 } from 'lucide-react'
import { useProfile } from '../../app/providers/contexts'
import { useDeviceStore } from './useDeviceStore'
import { todayKey } from '../../lib/dates'
import { cx } from '../../lib/cx'
import { EmptyState, Notice, PageHeader, Panel } from '../../components/ui'

const TOOLS = [
  { id: 'journal', label: 'Journal' },
  { id: 'habits', label: 'Habits' },
  { id: 'planner', label: 'Planner' },
  { id: 'reading', label: 'Reading' },
  { id: 'nutrition', label: 'Nutrition' },
  { id: 'goals', label: 'Goals' },
  { id: 'trading', label: 'Trading', experimental: true },
  { id: 'portfolio', label: 'Portfolio', experimental: true },
]

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

function EntryList({ items, render, onRemove, empty }) {
  if (items.length === 0) return <EmptyState title={empty} />
  return (
    <ul className="lab-list">
      {items.map((item) => (
        <li key={item.id} className="lab-row">
          <div className="lab-row__body">{render(item)}</div>
          <button type="button" className="icon-btn" aria-label="Delete entry" onClick={() => onRemove(item.id)}>
            <Trash2 size={15} />
          </button>
        </li>
      ))}
    </ul>
  )
}

function Journal({ userId }) {
  const [entries, setEntries] = useDeviceStore(userId, 'journal', [])
  const [win, setWin] = useState('')
  const [improve, setImprove] = useState('')
  const save = (e) => {
    e.preventDefault()
    if (!win.trim() && !improve.trim()) return
    setEntries((prev) => [{ id: uid(), at: new Date().toISOString(), win: win.trim(), improve: improve.trim() }, ...prev].slice(0, 200))
    setWin('')
    setImprove('')
  }
  return (
    <>
      <form className="form" onSubmit={save}>
        <label className="field">
          <span className="field__label">What went well today?</span>
          <textarea className="input textarea" rows={3} value={win} onChange={(e) => setWin(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">One thing to improve tomorrow</span>
          <textarea className="input textarea" rows={2} value={improve} onChange={(e) => setImprove(e.target.value)} />
        </label>
        <button type="submit" className="btn btn--primary btn--sm">Save entry</button>
      </form>
      <EntryList
        items={entries}
        empty="No journal entries on this device yet."
        onRemove={(id) => setEntries((prev) => prev.filter((x) => x.id !== id))}
        render={(x) => (
          <>
            <span className="fine-print">{new Date(x.at).toLocaleString()}</span>
            {x.win ? <p>{x.win}</p> : null}
            {x.improve ? <p className="muted">Improve: {x.improve}</p> : null}
          </>
        )}
      />
    </>
  )
}

const DEFAULT_HABITS = ['Hydration target', 'Read 30 pages', 'Move for 30 minutes', 'Evening reflection']

function Habits({ userId }) {
  const [habits, setHabits] = useDeviceStore(userId, 'habits', DEFAULT_HABITS)
  const [log, setLog] = useDeviceStore(userId, 'habit-log', {})
  const [draft, setDraft] = useState('')
  const today = todayKey()
  const done = new Set(log[today] || [])
  const toggle = (h) =>
    setLog((prev) => {
      const set = new Set(prev[today] || [])
      if (set.has(h)) set.delete(h)
      else set.add(h)
      return { ...prev, [today]: [...set] }
    })
  return (
    <>
      <p className="fine-print">Checks reset each day. Today: {done.size}/{habits.length}</p>
      <ul className="habit-list">
        {habits.map((h) => (
          <li key={h}>
            <label className={cx('exercise', done.has(h) && 'is-done')}>
              <input type="checkbox" checked={done.has(h)} onChange={() => toggle(h)} />
              <span className="exercise__name">{h}</span>
              <span className="exercise__check" aria-hidden="true">{done.has(h) ? <Check size={15} /> : null}</span>
            </label>
          </li>
        ))}
      </ul>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault()
          const v = draft.trim()
          if (v && !habits.includes(v)) setHabits((prev) => [...prev, v].slice(0, 12))
          setDraft('')
        }}
      >
        <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a habit" maxLength={60} />
        <button type="submit" className="btn btn--ghost btn--sm">Add</button>
      </form>
    </>
  )
}

function SimpleLog({ userId, name, fields, empty, render }) {
  const [items, setItems] = useDeviceStore(userId, name, [])
  const [draft, setDraft] = useState(() => Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ''])))
  const submit = (e) => {
    e.preventDefault()
    if (!fields.some((f) => String(draft[f.key]).trim())) return
    setItems((prev) => [{ id: uid(), at: new Date().toISOString(), ...draft }, ...prev].slice(0, 300))
    setDraft(Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ''])))
  }
  return (
    <>
      <form className="form form--row" onSubmit={submit}>
        {fields.map((f) => (
          <label key={f.key} className="field">
            <span className="field__label">{f.label}</span>
            {f.options ? (
              <select className="input select" value={draft[f.key]} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}>
                {f.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                type={f.type || 'text'}
                value={draft[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            )}
          </label>
        ))}
        <button type="submit" className="btn btn--primary btn--sm">Save</button>
      </form>
      <EntryList items={items} empty={empty} onRemove={(id) => setItems((prev) => prev.filter((x) => x.id !== id))} render={render} />
    </>
  )
}

function ToolBody({ tool, userId }) {
  switch (tool) {
    case 'journal':
      return <Journal userId={userId} />
    case 'habits':
      return <Habits userId={userId} />
    case 'planner':
      return (
        <SimpleLog
          userId={userId}
          name="planner"
          empty="No time blocks planned on this device."
          fields={[
            { key: 'time', label: 'Time', type: 'time', initial: '09:00' },
            { key: 'title', label: 'Block', placeholder: 'Deep work: ship feature' },
          ]}
          render={(x) => (
            <p>
              <strong className="tabular">{x.time}</strong> {x.title}
            </p>
          )}
        />
      )
    case 'reading':
      return (
        <SimpleLog
          userId={userId}
          name="reading"
          empty="No reading sessions logged on this device."
          fields={[
            { key: 'book', label: 'Book', placeholder: 'Title' },
            { key: 'pages', label: 'Pages', type: 'number', placeholder: '30' },
          ]}
          render={(x) => (
            <p>
              {x.book || 'Reading'} · <span className="tabular">{x.pages || 0} pages</span>{' '}
              <span className="fine-print">{new Date(x.at).toLocaleDateString()}</span>
            </p>
          )}
        />
      )
    case 'nutrition':
      return (
        <SimpleLog
          userId={userId}
          name="nutrition"
          empty="No nutrition entries on this device."
          fields={[
            { key: 'weight', label: 'Weight', type: 'number', placeholder: 'lbs' },
            { key: 'calories', label: 'Calories', type: 'number', placeholder: '2000' },
            { key: 'protein', label: 'Protein (g)', type: 'number', placeholder: '160' },
          ]}
          render={(x) => (
            <p className="tabular">
              {new Date(x.at).toLocaleDateString()} · {x.weight || '–'} lbs · {x.calories || '–'} kcal · {x.protein || '–'} g protein
            </p>
          )}
        />
      )
    case 'goals':
      return (
        <SimpleLog
          userId={userId}
          name="goals"
          empty="No goals saved on this device."
          fields={[
            { key: 'text', label: 'Goal', placeholder: 'What do you want to achieve?' },
            { key: 'due', label: 'Due', type: 'date' },
          ]}
          render={(x) => (
            <p>
              {x.text} {x.due ? <span className="fine-print">· due {new Date(`${x.due}T12:00:00`).toLocaleDateString()}</span> : null}
            </p>
          )}
        />
      )
    case 'trading':
      return (
        <SimpleLog
          userId={userId}
          name="trading"
          empty="No trades logged on this device."
          fields={[
            { key: 'ticker', label: 'Ticker', placeholder: 'NVDA' },
            { key: 'direction', label: 'Direction', options: ['Long', 'Short'], initial: 'Long' },
            { key: 'thesis', label: 'Thesis', placeholder: 'Why this trade?' },
          ]}
          render={(x) => (
            <p>
              <strong>{String(x.ticker).toUpperCase()}</strong> · {x.direction} {x.thesis ? <span className="muted">· {x.thesis}</span> : null}
            </p>
          )}
        />
      )
    case 'portfolio':
      return (
        <SimpleLog
          userId={userId}
          name="portfolio"
          empty="No snapshots saved on this device."
          fields={[{ key: 'value', label: 'Portfolio value ($)', type: 'number', placeholder: '12450' }]}
          render={(x) => (
            <p className="tabular">
              {new Date(x.at).toLocaleDateString()} · ${Number(x.value || 0).toLocaleString()}
            </p>
          )}
        />
      )
    default:
      return null
  }
}

export default function Lab() {
  const { profile } = useProfile()
  const [tool, setTool] = useState('journal')
  const meta = TOOLS.find((t) => t.id === tool)

  return (
    <div className="page">
      <PageHeader
        eyebrow="Experimental"
        title="Lab"
        lede="Lightweight personal notebooks. Useful today, not yet part of the progression system."
      />
      <Notice tone="info" title="Saved on this device only">
        Lab entries live in this browser. They don’t sync across devices and don’t earn XP.
      </Notice>
      <div className="tabs tabs--scroll" role="tablist" aria-label="Lab tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tool === t.id}
            className={cx('tab', tool === t.id && 'is-active')}
            onClick={() => setTool(t.id)}
          >
            {t.label}
            {t.experimental ? <FlaskConical size={13} aria-label="experimental" /> : null}
          </button>
        ))}
      </div>
      <Panel title={meta.label} meta={meta.experimental ? 'Experimental: outside the core ZBXP loop.' : undefined}>
        <ToolBody key={tool} tool={tool} userId={profile.id} />
      </Panel>
    </div>
  )
}
