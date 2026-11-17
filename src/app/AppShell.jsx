import { Suspense, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Download,
  Dumbbell,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  ScrollText,
  ShieldHalf,
  Timer,
  UsersRound,
  X,
} from 'lucide-react'
import { useAuth, useFocus, useProfile } from './providers/contexts'
import { getPathConfig } from '../config/pathConfig'
import { progressionSnapshot } from '../lib/progression'
import { formatClock } from '../lib/dates'
import { Meter, RankEmblem, SkeletonList } from '../components/ui'
import { cx } from '../lib/cx'

function useNavItems(pathConfig) {
  return {
    primary: [
      { to: '/dashboard', label: 'Command', icon: LayoutDashboard },
      { to: '/quests', label: pathConfig.questNounPlural, icon: ScrollText },
      { to: '/focus', label: 'Focus', icon: Timer },
      { to: '/character', label: 'Character', icon: ShieldHalf },
      { to: '/guild', label: 'Guild', icon: UsersRound },
      { to: '/gym', label: 'Training', icon: Dumbbell },
    ],
    secondary: [{ to: '/lab', label: 'Lab', icon: FlaskConical, note: 'Experimental' }],
  }
}

function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null)
  useEffect(() => {
    const onPrompt = (event) => {
      event.preventDefault()
      setDeferred(event)
    }
    const onInstalled = () => setDeferred(null)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])
  const install = async () => {
    if (!deferred) return
    deferred.prompt()
    await deferred.userChoice.catch(() => null)
    setDeferred(null)
  }
  return { canInstall: Boolean(deferred), install }
}

function CharacterChip({ profile, compact = false }) {
  const snap = progressionSnapshot(profile.xp, profile.path)
  return (
    <NavLink to="/character" className={cx('char-chip', compact && 'char-chip--compact')} aria-label="Open character">
      <RankEmblem rank={snap.rankInfo.rank} size={compact ? 34 : 40} label={`Rank ${snap.rankInfo.rank}`} />
      <span className="char-chip__text">
        <span className="char-chip__name">{profile.displayName}</span>
        <span className="char-chip__meta tabular">
          Lv {snap.level} · {snap.xp.toLocaleString()} XP
        </span>
        {!compact ? <Meter value={snap.into} max={snap.needed} size="xs" label="Level progress" /> : null}
      </span>
    </NavLink>
  )
}

function FocusPill() {
  const { state, remainingMs, isActive } = useFocus()
  const location = useLocation()
  if (!isActive || location.pathname === '/focus') return null
  return (
    <NavLink to="/focus" className={cx('focus-pill', state.status === 'paused' && 'is-paused')}>
      <Timer size={15} aria-hidden="true" />
      <span className="tabular">{formatClock(remainingMs / 1000)}</span>
      <span className="focus-pill__label">{state.status === 'paused' ? 'Paused' : 'Focusing'}</span>
    </NavLink>
  )
}

export function AppShell() {
  const { profile } = useProfile()
  const { signOut } = useAuth()
  const pathConfig = getPathConfig(profile.path)
  const nav = useNavItems(pathConfig)
  const { canInstall, install } = useInstallPrompt()
  const location = useLocation()
  const mainRef = useRef(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [lastPath, setLastPath] = useState(location.pathname)

  if (lastPath !== location.pathname) {
    setLastPath(location.pathname)
    setMoreOpen(false)
  }

  // On in-app navigation, move focus to the main region for keyboard and
  // screen-reader users. Skipped on first load so Tab reaches the skip link.
  const prevPathRef = useRef(location.pathname)
  useEffect(() => {
    if (prevPathRef.current === location.pathname) return
    prevPathRef.current = location.pathname
    window.scrollTo({ top: 0 })
    mainRef.current?.focus({ preventScroll: true })
  }, [location.pathname])

  const mobileTabs = [nav.primary[0], nav.primary[1], nav.primary[2], nav.primary[4]]
  const moreItems = [nav.primary[3], nav.primary[5], ...nav.secondary]

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <aside className="sidebar" aria-label="Sidebar">
        <div className="brand-mark">
          <span className="brand-mark__glyph" aria-hidden="true">Z</span>
          <span className="brand-mark__name">ZBXP</span>
          <span className="brand-mark__path">{pathConfig.title}</span>
        </div>
        <nav aria-label="Primary">
          <ul className="nav-list">
            {nav.primary.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink to={to} className={({ isActive }) => cx('nav-link', isActive && 'is-active')}>
                  <Icon size={18} aria-hidden="true" />
                  <span>{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
          <p className="nav-section">More</p>
          <ul className="nav-list">
            {nav.secondary.map(({ to, label, icon: Icon, note }) => (
              <li key={to}>
                <NavLink to={to} className={({ isActive }) => cx('nav-link', 'nav-link--secondary', isActive && 'is-active')}>
                  <Icon size={18} aria-hidden="true" />
                  <span>{label}</span>
                  <span className="nav-link__note">{note}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sidebar__footer">
          <CharacterChip profile={profile} />
          <div className="sidebar__actions">
            {canInstall ? (
              <button type="button" className="btn btn--quiet btn--sm" onClick={install}>
                <Download size={16} aria-hidden="true" /> Install app
              </button>
            ) : null}
            <button type="button" className="btn btn--quiet btn--sm" onClick={signOut}>
              <LogOut size={16} aria-hidden="true" /> Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="shell__main">
        <header className="topbar">
          <div className="topbar__brand brand-mark">
            <span className="brand-mark__glyph" aria-hidden="true">Z</span>
            <span className="brand-mark__name">ZBXP</span>
          </div>
          <div className="topbar__right">
            <FocusPill />
            <CharacterChip profile={profile} compact />
          </div>
        </header>

        <main id="main" ref={mainRef} tabIndex={-1} className="page-container">
          <div key={location.pathname} className="route-transition">
            <Suspense fallback={<SkeletonList rows={4} />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Primary (mobile)">
        {mobileTabs.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => cx('bottom-nav__item', isActive && 'is-active')}>
            <Icon size={20} aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          className={cx('bottom-nav__item', moreOpen && 'is-active')}
          aria-expanded={moreOpen}
          aria-controls="more-sheet"
          onClick={() => setMoreOpen((v) => !v)}
        >
          {moreOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          <span>More</span>
        </button>
      </nav>

      {moreOpen ? (
        <div className="sheet-backdrop" onClick={() => setMoreOpen(false)} role="presentation">
          <div
            id="more-sheet"
            className="sheet"
            role="dialog"
            aria-label="More"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === 'Escape' && setMoreOpen(false)}
          >
            {moreItems.map(({ to, label, icon: Icon, note }) => (
              <NavLink key={to} to={to} className="sheet__item">
                <Icon size={18} aria-hidden="true" />
                <span>{label}</span>
                {note ? <span className="nav-link__note">{note}</span> : null}
              </NavLink>
            ))}
            {canInstall ? (
              <button type="button" className="sheet__item" onClick={install}>
                <Download size={18} aria-hidden="true" />
                <span>Install app</span>
              </button>
            ) : null}
            <button type="button" className="sheet__item" onClick={signOut}>
              <LogOut size={18} aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
