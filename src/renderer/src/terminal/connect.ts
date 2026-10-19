import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { openContainer, openLocal, openSsh } from './sessions'

// Opens still pending, shared by every caller: a double-click or a repeated Enter must not open twice.
const pending = new Set<string>()
const LOCAL_KEY = 'local'

async function once(key: string, open: () => Promise<string | undefined>): Promise<string | undefined> {
  if (pending.has(key)) return undefined
  pending.add(key)
  try {
    return await open()
  } finally {
    pending.delete(key)
  }
}

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
    if (await once(`${hostId}:${environmentId ?? ''}`, () => openSsh(hostId, environmentId))) navigateRef.current('/terminals')
  }, [])
  const connectContainer = useCallback(async (hostId: string, environmentId: string | null, ref: string) => {
    if (await once(`${hostId}:${environmentId ?? ''}:${ref}`, () => openContainer(hostId, environmentId, ref))) navigateRef.current('/terminals')
  }, [])
  const connectLocal = useCallback(async () => {
    if (await once(LOCAL_KEY, openLocal)) navigateRef.current('/terminals')
  }, [])
  return { connect, connectContainer, connectLocal }
}
