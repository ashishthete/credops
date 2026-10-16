import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { openLocal, openSsh } from './sessions'

/**
 * Opens a session from anywhere in the app and goes to the Terminals page once it exists.
 * A failed open has already toasted, so the user stays where they were.
 */
export function useConnect() {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  })
  const connect = useCallback(async (hostId: string, environmentId?: string) => {
    if (await openSsh(hostId, environmentId)) navigateRef.current('/terminals')
  }, [])
  const connectLocal = useCallback(async () => {
    if (await openLocal()) navigateRef.current('/terminals')
  }, [])
  return { connect, connectLocal }
}
