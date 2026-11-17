import { lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './providers/AuthProvider'
import { ProfileProvider } from './providers/ProfileProvider'
import { PlayerDataProvider } from './providers/PlayerDataProvider'
import { RewardProvider } from './providers/RewardProvider'
import { FocusProvider } from '../features/focus/FocusProvider'
import { useAuth, useProfile } from './providers/contexts'
import { useThemePath } from './useThemePath'
import { AppShell } from './AppShell'
import { UpdatePrompt } from './UpdatePrompt'
import { AuthScreen } from '../features/auth/AuthScreen'
import { AuthCallback } from '../features/auth/AuthCallback'
import { Onboarding } from '../features/auth/Onboarding'
import { Notice, Spinner } from '../components/ui'

const CommandCenter = lazy(() => import('../features/dashboard/CommandCenter'))
const QuestBoard = lazy(() => import('../features/quests/QuestBoard'))
const FocusChamber = lazy(() => import('../features/focus/FocusChamber'))
const CharacterPage = lazy(() => import('../features/character/CharacterPage'))
const GuildHall = lazy(() => import('../features/guild/GuildHall'))
const TrainingGrounds = lazy(() => import('../features/gym/TrainingGrounds'))
const Lab = lazy(() => import('../features/lab/Lab'))
const NotFound = lazy(() => import('./NotFound'))

function Splash({ label }) {
  return (
    <main className="center-screen" aria-busy="true">
      <div className="splash">
        <div className="brand-mark brand-mark--lg">
          <span className="brand-mark__glyph" aria-hidden="true">Z</span>
          <span className="brand-mark__name">ZBXP</span>
        </div>
        <p className="muted">
          <Spinner label={label} /> {label}
        </p>
      </div>
    </main>
  )
}

function ProfileError() {
  const { error, reload } = useProfile()
  const { signOut } = useAuth()
  return (
    <main className="center-screen">
      <div className="center-card">
        <Notice tone="error" title="We couldn’t load your character">
          {error?.message}
        </Notice>
        <div className="row-actions">
          <button type="button" className="btn btn--primary" onClick={reload}>
            Try again
          </button>
          <button type="button" className="btn btn--ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    </main>
  )
}

function SignedInApp() {
  return (
    <PlayerDataProvider>
      <FocusProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<CommandCenter />} />
            <Route path="quests" element={<QuestBoard />} />
            <Route path="focus" element={<FocusChamber />} />
            <Route path="character" element={<CharacterPage />} />
            <Route path="guild" element={<GuildHall />} />
            <Route path="gym" element={<TrainingGrounds />} />
            <Route path="lab" element={<Lab />} />
            {/* Legacy URLs from the previous build */}
            <Route path="skills" element={<Navigate to="/character" replace />} />
            <Route path="stats" element={<Navigate to="/character" replace />} />
            <Route path="leaderboard" element={<Navigate to="/guild" replace />} />
            <Route path="tools" element={<Navigate to="/lab" replace />} />
            <Route path="boss" element={<Navigate to="/dashboard" replace />} />
            <Route path="ai" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </FocusProvider>
    </PlayerDataProvider>
  )
}

function Gate() {
  const auth = useAuth()
  const profileState = useProfile()
  useThemePath(profileState.profile?.path)

  if (auth.status === 'loading') return <Splash label="Restoring your session…" />
  if (auth.status === 'signedOut') return <AuthScreen />
  if (profileState.status === 'error') return <ProfileError />
  if (!profileState.profile) return <Splash label="Loading your character…" />
  if (!profileState.profile.path) return <Onboarding />
  return <SignedInApp />
}

export default function App() {
  return (
    <AuthProvider>
      <ProfileProvider>
        <RewardProvider>
          <UpdatePrompt />
          <Routes>
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="*" element={<Gate />} />
          </Routes>
        </RewardProvider>
      </ProfileProvider>
    </AuthProvider>
  )
}
