import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { useInventory } from '../inventory/store'
import { api } from '../lib/api'
import { attempt } from '../ui/common'
import { registerCommand, registerCommands } from '../ui/commands'
import { toast } from '../ui/Toaster'

export const SETTINGS_PATH = '/settings'

/** Palette: the settings page, plus a Teams test and a QA run per environment. */
export function useSettingsCommands(): void {
  const data = useInventory()
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  })

  useEffect(
    () =>
      registerCommand({
        id: 'settings.integrations',
        title: 'Settings: AI & integrations',
        // Not 'Navigate': that group is the numbered sections, each with a ⌘ shortcut.
        section: 'Settings',
        keywords: ['settings', 'preferences', 'claude', 'teams', 'sendgrid', 'github', 'notifications'],
        run: () => void navigateRef.current(SETTINGS_PATH),
      }),
    [],
  )

  useEffect(() => {
    if (!data) return
    return registerCommands(
      data.environments.flatMap((e) => [
        {
          id: `notify.test-teams:${e.id}`,
          title: `Send test Teams message to ${e.name}`,
          section: 'Notifications',
          keywords: ['teams', 'webhook', 'notify'],
          run: async () => {
            const ok = await attempt(`Couldn't send a test Teams message to ${e.name}`, async () => {
              await api.invoke('notify:test', { channel: 'teams', environmentId: e.id })
              return true
            })
            if (ok) toast({ title: `Test Teams message sent to ${e.name}`, tone: 'success' })
          },
        },
        {
          id: `qa.run:${e.id}`,
          title: `Run QA for ${e.name}`,
          section: 'Notifications',
          keywords: ['qa', 'github', 'workflow', 'tests'],
          run: async () => {
            const d = await attempt(`Couldn't start QA for ${e.name}`, () => api.invoke('qa:dispatch', e.id))
            if (d) toast({ title: `QA started for ${e.name}`, description: `${d.repo} · ${d.workflow}`, tone: 'success' })
          },
        },
      ]),
    )
  }, [data])
}
