import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import { useInventory } from '../inventory/store'
import { sessionStore } from '../terminal/sessions'
import { registerCommands, type Command } from '../ui/commands'
import { requestInsert } from './insert'
import { loadSnippets, snippetStore } from './snippets'

/** `/ops/snippets?action=new` opens the snippet dialog, so the command works from any page. */
export const newSnippetPath = '/ops/snippets?action=new'

/**
 * Palette commands for Ops: run a command, new snippet, run or insert each snippet, and the containers of each host.
 * Insert commands exist only while a terminal tab is active.
 */
export function useOpsCommands(): void {
  const data = useInventory()
  const { snippets, loaded } = useSyncExternalStore(snippetStore.subscribe, snippetStore.get)
  const { sessions, activeId } = useSyncExternalStore(sessionStore.subscribe, sessionStore.get)
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  })
  const go = useCallback((path: string) => () => navigateRef.current(path), [])

  useEffect(() => {
    if (!loaded) void loadSnippets()
  }, [loaded])

  useEffect(
    () =>
      registerCommands([
      { id: 'ops.run', title: 'Run a command on hosts…', section: 'Ops', keywords: ['ssh', 'execute', 'multi-host', 'parallel'], run: go('/ops/run') },
      { id: 'ops.snippet.new', title: 'New snippet', section: 'Ops', keywords: ['script', 'template'], run: go(newSnippetPath) },
      ]),
    [go],
  )

  const active = sessions.find((s) => s.id === activeId)
  const hostId = active?.hostId ?? null
  const hasTab = !!active
  useEffect(() => {
    const cmds: Command[] = snippets.flatMap((s) => {
      const keywords = [...s.tags, 'snippet']
      const run: Command = {
        id: `ops.snippet.run.${s.id}`,
        title: `Run snippet: ${s.label}`,
        section: 'Ops',
        keywords,
        // The host of the active terminal tab is preselected when there is one.
        run: go(`/ops/run?snippet=${encodeURIComponent(s.id)}${hostId ? `&hosts=${encodeURIComponent(hostId)}` : ''}`),
      }
      const insert: Command = {
        id: `ops.snippet.insert.${s.id}`,
        title: `Insert snippet into terminal: ${s.label}`,
        section: 'Ops',
        keywords,
        run: () => requestInsert(s.id),
      }
      return hasTab ? [run, insert] : [run]
    })
    return registerCommands(cmds)
  }, [snippets, hostId, hasTab, go])

  useEffect(
    () =>
      registerCommands(
        (data?.hosts ?? []).map((h) => ({
          id: `ops.containers.${h.id}`,
          title: `Containers on ${h.label}`,
          section: 'Ops',
          keywords: ['docker', 'logs', 'compose'],
          run: go(`/ops/containers?host=${encodeURIComponent(h.id)}`),
        })),
      ),
    [data, go],
  )
}
