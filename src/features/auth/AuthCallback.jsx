import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../../app/providers/contexts'
import { Notice, Spinner } from '../../components/ui'

// Supabase (PKCE + detectSessionInUrl) exchanges the ?code= automatically
// during client initialization; this page only reflects the outcome.
function readUrlError() {
  const url = new URL(window.location.href)
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''))
  return (
    url.searchParams.get('error_description') ||
    hash.get('error_description') ||
    url.searchParams.get('error') ||
    hash.get('error') ||
    ''
  )
}

export function AuthCallback() {
  const auth = useAuth()
  const urlError = readUrlError()

  if (auth.status === 'signedIn') return <Navigate to="/dashboard" replace />

  return (
    <main className="center-screen">
      <div className="center-card">
        <div className="brand-mark">
          <span className="brand-mark__glyph" aria-hidden="true">Z</span>
          <span className="brand-mark__name">ZBXP</span>
        </div>
        {auth.status === 'loading' && !urlError ? (
          <p className="muted">
            <Spinner /> Verifying your sign-in link…
          </p>
        ) : (
          <>
            <Notice tone={urlError ? 'error' : 'info'} title={urlError ? 'Sign-in link problem' : 'Link processed'}>
              {urlError || 'This link has expired or was already used. Please sign in.'}
            </Notice>
            <Link to="/" replace className="btn btn--primary btn--block">
              Go to sign in
            </Link>
          </>
        )}
      </div>
    </main>
  )
}
