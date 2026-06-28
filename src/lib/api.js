import { supabase } from './supabase'

// .NET backend — port 5033 (was Node on 3002)
export const BACKEND = 'http://localhost:5033'

/**
 * fetch() wrapper that automatically attaches the Supabase JWT as a Bearer token.
 * Replaces the old pattern of sending user_id in the request body.
 *
 * Usage:
 *   const res = await backendFetch('/api/plaid/sync', { method: 'POST' })
 */
export async function backendFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession()

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  }

  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`
  }

  return fetch(`${BACKEND}${path}`, { ...options, headers })
}
