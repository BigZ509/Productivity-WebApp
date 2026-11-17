import { useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { useAuth, useProfile } from '../../app/providers/contexts'
import { PATH_CONFIG, PATH_KEYS } from '../../config/pathConfig'
import { setIdentity } from '../../services/profile'
import { Notice, RankEmblem, Spinner } from '../../components/ui'
import { cx } from '../../lib/cx'
import { useThemePath } from '../../app/useThemePath'

export function Onboarding() {
  const { profile, reload } = useProfile()
  const { signOut } = useAuth()
  const initialName = profile?.displayName?.startsWith('Hunter#') ? '' : profile?.displayName || ''
  const [name, setName] = useState(initialName)
  const [path, setPath] = useState(profile?.path || 'HUNTER')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useThemePath(path)

  const onSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await setIdentity({ displayName: name.trim(), path })
      await reload()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <main className="onboarding">
      <form className="onboarding__card" onSubmit={onSubmit}>
        <p className="eyebrow">Create your character</p>
        <h1 className="page-title">Choose your path</h1>
        <p className="page-lede">
          Both paths use the same quests, XP and ranks. Your path sets your quest pool, vocabulary and theme. You can
          change it later.
        </p>

        <fieldset className="path-picker">
          <legend className="sr-only">Path</legend>
          {PATH_KEYS.map((key) => {
            const cfg = PATH_CONFIG[key]
            const selected = path === key
            return (
              <label key={key} className={cx('path-card', `path-card--${key.toLowerCase()}`, selected && 'is-selected')}>
                <input
                  type="radio"
                  name="path"
                  value={key}
                  checked={selected}
                  onChange={() => setPath(key)}
                  className="sr-only"
                />
                <span className="path-card__head">
                  <RankEmblem rank="E" size={44} label="" />
                  <span>
                    <strong className="path-card__title">{cfg.title}</strong>
                    <span className="path-card__tag">{cfg.tagline}</span>
                  </span>
                  <span className="path-card__check" aria-hidden="true">
                    {selected ? <Check size={16} /> : null}
                  </span>
                </span>
                <span className="path-card__desc">{cfg.description}</span>
              </label>
            )
          })}
        </fieldset>

        <label className="field">
          <span className="field__label">Display name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            maxLength={24}
            placeholder={path === 'HUNTER' ? 'e.g. Ironwill' : 'e.g. Crimson Lotus'}
            required
            autoComplete="nickname"
          />
          <span className="field__hint">Shown to guildmates on leaderboards. 2–24 characters, no email addresses.</span>
        </label>

        {error ? <Notice tone="error">{error}</Notice> : null}

        <div className="onboarding__actions">
          <button type="button" className="btn btn--quiet" onClick={signOut}>
            Sign out
          </button>
          <button type="submit" className="btn btn--primary btn--lg" disabled={busy || name.trim().length < 2}>
            {busy ? <Spinner label="Saving" /> : null}
            Begin as {PATH_CONFIG[path].title}
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </div>
      </form>
    </main>
  )
}
