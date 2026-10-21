import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { registerCommands } from '../ui/commands'
import { hubStore, signInHub, signOutHub, useHub } from './store'

export const hubPath = '/hub'
/** The Hub page, whose URL field is focused on arrival; "Connect…" has nowhere else to go. */
export const connectHubPath = '/hub'

/** Palette commands: Hub: Connect…, Sign in, Sign out, Open, Team deployments, and Deploy to each team environment. */
export function useHubCommands(): void {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  })
  // One "Deploy to <env> (Hub)" per team environment the person can see.
  const { catalog } = useHub()
  useEffect(
    () =>
      registerCommands([
        { id: 'hub.deployments', title: 'Hub: Team deployments', section: 'Hub', keywords: ['team', 'environments', 'locks'], run: () => navigateRef.current('/deployments') },
        ...catalog.map((c) => ({
          id: `hub.deploy.${c.environment.id}`,
          title: `Deploy to ${c.environment.name} (Hub)`,
          section: 'Hub',
          keywords: ['team', 'release'],
          run: () => navigateRef.current(`/deployments?env=${encodeURIComponent(c.environment.id)}&action=deploy`),
        })),
      ]),
    [catalog],
  )
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
