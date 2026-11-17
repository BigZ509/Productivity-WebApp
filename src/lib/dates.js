// Date helpers. Activity is bucketed by the viewer's LOCAL calendar day.

export function dayKey(dateLike) {
  const d = new Date(dateLike)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayKey(now = new Date()) {
  return dayKey(now)
}

export function startOfLocalDay(now = new Date()) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d
}

// Weeks start on Monday (local time).
export function startOfLocalWeek(now = new Date()) {
  const d = startOfLocalDay(now)
  const diffToMonday = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - diffToMonday)
  return d
}

export function addDays(date, days) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

export function weekDays(now = new Date()) {
  const start = startOfLocalWeek(now)
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(start, i)
    return {
      key: dayKey(date),
      date,
      label: date.toLocaleDateString(undefined, { weekday: 'short' }),
      isToday: dayKey(date) === dayKey(now),
      isFuture: date > now,
    }
  })
}

export function relativeTime(dateLike, now = Date.now()) {
  const diff = (new Date(dateLike).getTime() - now) / 1000
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 60) return rtf.format(Math.round(diff), 'second')
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day')
  return new Date(dateLike).toLocaleDateString()
}

export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
