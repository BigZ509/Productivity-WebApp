import { BookOpen, Briefcase, Code2, Dumbbell, LoaderCircle, Target } from 'lucide-react'
import { CATEGORY_META, DIFFICULTY_META } from '../config/pathConfig'
import { cx } from '../lib/cx'

export function PageHeader({ eyebrow, title, lede, actions }) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 className="page-title">{title}</h1>
        {lede ? <p className="page-lede">{lede}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  )
}

export function Panel({ title, meta, actions, children, className, as: Tag = 'section', ...rest }) {
  return (
    <Tag className={cx('panel', className)} {...rest}>
      {title || actions ? (
        <div className="panel__header">
          <div>
            {title ? <h2 className="panel__title">{title}</h2> : null}
            {meta ? <p className="panel__meta">{meta}</p> : null}
          </div>
          {actions ? <div className="panel__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </Tag>
  )
}

export function Meter({ value, max = 1, label, tone = 'accent', size = 'md', valueText }) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  return (
    <div
      className={cx('meter', `meter--${tone}`, `meter--${size}`)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={valueText}
    >
      <span className="meter__fill" style={{ '--fill': ratio }} />
    </div>
  )
}

export function RankEmblem({ rank = 'E', size = 72, label }) {
  return (
    <svg
      className={cx('emblem', `emblem--${rank.toLowerCase()}`)}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={label || `Rank ${rank}`}
    >
      <polygon className="emblem__outer" points="50,3 91,26.5 91,73.5 50,97 9,73.5 9,26.5" />
      <polygon className="emblem__inner" points="50,14 81,32 81,68 50,86 19,68 19,32" />
      <text className="emblem__letter" x="50" y="51" textAnchor="middle" dominantBaseline="central">
        {rank}
      </text>
    </svg>
  )
}

export function Notice({ tone = 'info', title, children, action }) {
  return (
    <div className={cx('notice', `notice--${tone}`)} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="notice__body">
        {title ? <strong className="notice__title">{title}</strong> : null}
        {children ? <span>{children}</span> : null}
      </div>
      {action ? <div className="notice__action">{action}</div> : null}
    </div>
  )
}

export function EmptyState({ icon: Icon = Target, title, children, action }) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon" aria-hidden="true">
        <Icon size={22} />
      </span>
      <p className="empty-state__title">{title}</p>
      {children ? <p className="empty-state__text">{children}</p> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  )
}

export function Spinner({ label = 'Loading' }) {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <LoaderCircle size={18} aria-hidden="true" />
    </span>
  )
}

export function SkeletonList({ rows = 3 }) {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  )
}

// Standard loading / error / content switch for a data slice.
export function AsyncBlock({ slice, rows = 3, children, errorTitle = 'Couldn’t load this' }) {
  if (slice.status === 'loading' || (slice.status === 'idle' && !slice.data)) return <SkeletonList rows={rows} />
  if (slice.status === 'error' && !slice.data) {
    return (
      <Notice
        tone="error"
        title={errorTitle}
        action={
          <button type="button" className="btn btn--ghost btn--sm" onClick={slice.reload}>
            Retry
          </button>
        }
      >
        {slice.error?.message}
      </Notice>
    )
  }
  return children(slice.data)
}

const CATEGORY_ICONS = { coding: Code2, study: BookOpen, business: Briefcase, gym: Dumbbell }

export function CategoryIcon({ category, size = 18 }) {
  const Icon = CATEGORY_ICONS[category] || Target
  return (
    <span className={cx('cat-icon', `cat-icon--${category}`)} aria-hidden="true">
      <Icon size={size} />
    </span>
  )
}

export function CategoryLabel({ category }) {
  return CATEGORY_META[category]?.label || category
}

export function DifficultyPips({ difficulty }) {
  const meta = DIFFICULTY_META[difficulty] || DIFFICULTY_META.easy
  return (
    <span className={cx('pips', `pips--${difficulty}`)} title={`${meta.label} difficulty`}>
      <span className="sr-only">{meta.label} difficulty</span>
      {[1, 2, 3].map((n) => (
        <span key={n} className={cx('pip', n <= meta.pips && 'is-on')} aria-hidden="true" />
      ))}
      <span className="pips__label" aria-hidden="true">
        {meta.label}
      </span>
    </span>
  )
}

export function XpValue({ value, prefix = '' }) {
  return (
    <span className="xp-value tabular">
      {prefix}
      {Number(value || 0).toLocaleString()}
      <span className="xp-value__unit">XP</span>
    </span>
  )
}
