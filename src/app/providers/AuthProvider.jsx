import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { toAppError } from '../../lib/errors'
import { AuthContext } from './contexts'

const RESTORE_TIMEOUT_MS = 10000

export function AuthProvider({ children }) {
  const [state, setState] = useState(() => ({
    status: supabase ? 'loading' : 'signedOut',
    session: null,
    notice: '',
  }))
  const signingOutRef = useRef(false)
  const hadSessionRef = useRef(false)

  useEffect(() => {
    if (!supabase) return undefined
    let active = true

    // IMPORTANT: this callback must stay synchronous and must not call other
    // Supabase APIs. The auth client holds its lock while invoking it, so
    // awaiting a query here deadlocks (the root cause of the old no-op lock
    // workaround). Data loading reacts to the session in ProfileProvider.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return
      const expired = event === 'SIGNED_OUT' && hadSessionRef.current && !signingOutRef.current
      hadSessionRef.current = Boolean(session)
      signingOutRef.current = false
      setState({
        status: session ? 'signedIn' : 'signedOut',
        session: session || null,
        notice: expired ? 'Your session ended. Please sign in again.' : '',
      })
    })

    // Safety net: INITIAL_SESSION normally arrives quickly. Never leave the
    // user on an infinite splash if storage or the network stalls.
    const timer = setTimeout(() => {
      if (!active) return
      setState((prev) =>
        prev.status === 'loading'
          ? { status: 'signedOut', session: null, notice: 'Restoring your session took too long. Please sign in.' }
          : prev,
      )
    }, RESTORE_TIMEOUT_MS)

    return () => {
      active = false
      clearTimeout(timer)
      subscription.unsubscribe()
    }
  }, [])

  const signOut = useCallback(async () => {
    if (!supabase) return
    signingOutRef.current = true
    const { error } = await supabase.auth.signOut()
    if (error) {
      // Server revocation failed (e.g. offline); still drop the local session.
      await supabase.auth.signOut({ scope: 'local' })
    }
  }, [])

  const signInWithPassword = useCallback(async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) throw toAppError(error)
  }, [])

  const signUp = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    })
    if (error) throw toAppError(error)
    return { needsConfirmation: !data.session }
  }, [])

  const signInWithGoogle = useCallback(async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    if (error) throw toAppError(error)
  }, [])

  const value = useMemo(
    () => ({
      ...state,
      user: state.session?.user || null,
      signOut,
      signInWithPassword,
      signUp,
      signInWithGoogle,
      clearNotice: () => setState((prev) => ({ ...prev, notice: '' })),
    }),
    [state, signOut, signInWithPassword, signUp, signInWithGoogle],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
