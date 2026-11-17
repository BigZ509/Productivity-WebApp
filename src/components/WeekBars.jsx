import { weekDays } from '../lib/dates'
import { cx } from '../lib/cx'

// Single-series 7-day bar chart of XP per local day (Mon-Sun).
// Bars are anchored to the baseline; a per-bar tooltip and an sr-only
// table expose exact values.
export function WeekBars({ byDay, label = 'XP earned per day this week' }) {
  const days = weekDays()
  const values = days.map((d) => byDay[d.key] || 0)
  const max = Math.max(...values, 1)

  return (
    <figure className="weekbars">
      <div className="weekbars__plot" aria-hidden="true">
        {days.map((d, i) => {
          const v = values[i]
          return (
            <div key={d.key} className={cx('weekbars__col', d.isToday && 'is-today', d.isFuture && 'is-future')}>
              <div className="weekbars__track">
                <span
                  className={cx('weekbars__bar', v === 0 && 'is-zero')}
                  style={{ '--h': v === 0 ? 0 : Math.max(0.06, v / max) }}
                />
                <span className="weekbars__tip tabular">
                  {d.label}: {v} XP
                </span>
              </div>
              <span className="weekbars__label">{d.label.slice(0, 2)}</span>
            </div>
          )
        })}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {days.map((d, i) => (
            <tr key={d.key}>
              <th scope="row">{d.date.toLocaleDateString(undefined, { weekday: 'long' })}</th>
              <td>{values[i]} XP</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
