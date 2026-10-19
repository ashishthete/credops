import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { registerCommands } from '../ui/commands'
import { hubStore, signInHub, signOutHub } from './store'

export const hubPath = '/hub'
/** The Hub page, whose URL field is focused on arrival; "Connect…" has nowhere else to go. */
export const connectHubPath = '/hub'

/** Palette commands: Hub: Connect…, Hub: Sign in, Hub: Sign out and Hub: Open. */
export function useHubCommands(): void {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  })
  useEffect(
    () =>
      registerCommands([
        { id: 'hub.open', title: 'Hub: Open', section: 'Hub', keywords: ['team', 'sso'], run: () => navigateRef.current(hubPath) },
        { id: 'hub.connect', title: 'Hub: Connect…', section: 'Hub', keywords: ['link', 'url', 'server'], run: () => navigateRef.current(connectHubPath) },
        {
          id: 'hub.signin',
          title: 'Hub: Sign in',
          section: 'Hub',
          keywords: ['microsoft', 'entra', 'sso', 'login'],
          run: () => {
            const s = hubStore.get().status
            if (!s.linked) navigateRef.current(connectHubPath)
            else if (!s.signedIn && !s.signingIn) void signInHub()
            else navigateRef.current(hubPath)
          },
        },
        {
          id: 'hub.signout',
          title: 'Hub: Sign out',
          section: 'Hub',
          keywords: ['logout'],
          run: () => {
            const s = hubStore.get().status
            if (s.linked && s.signedIn) void signOutHub()
            else navigateRef.current(hubPath)
          },
        },
      ]),
    [],
  )
}
