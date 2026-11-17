// Normalizes Supabase/PostgREST/network errors into user-facing messages.
// Server RPCs attach a stable machine code in `hint` (see migration
// 20261117000100); the message text is already written for users.

const CODE_MESSAGES = {
  NOT_AUTHENTICATED: 'Your session ended. Sign in again to continue.',
}

export class AppError extends Error {
  constructor(message, { code = 'UNKNOWN', cause } = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.cause = cause
  }
}

export function toAppError(error, fallback = 'Something went wrong. Please try again.') {
  if (!error) return new AppError(fallback)
  if (error instanceof AppError) return error

  const hint = typeof error.hint === 'string' ? error.hint : ''
  const raw = String(error.message || error.error_description || error || '')
  const lower = raw.toLowerCase()

  if (hint && /^[A-Z_]+$/.test(hint)) {
    return new AppError(CODE_MESSAGES[hint] || raw || fallback, { code: hint, cause: error })
  }
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('load failed')) {
    return new AppError('Can’t reach the server. Check your connection and try again.', { code: 'NETWORK', cause: error })
  }
  if (lower.includes('jwt expired') || error.code === 'PGRST301') {
    return new AppError(CODE_MESSAGES.NOT_AUTHENTICATED, { code: 'NOT_AUTHENTICATED', cause: error })
  }
  if (error.code === '42501' || lower.includes('permission denied')) {
    return new AppError('That action isn’t allowed.', { code: 'FORBIDDEN', cause: error })
  }
  if (error.code === 'PGRST202') {
    return new AppError(
      'The server is missing a required update. Apply the latest database migration.',
      { code: 'SCHEMA_OUTDATED', cause: error },
    )
  }
  return new AppError(raw || fallback, { code: error.code || 'UNKNOWN', cause: error })
}

// Unwraps a supabase-js response, throwing a normalized AppError on failure.
export function unwrap({ data, error }, fallback) {
  if (error) throw toAppError(error, fallback)
  return data
}

export function firstRow(data) {
  return Array.isArray(data) ? data[0] ?? null : data ?? null
}
