import { useEffect, useState } from 'react'
import { api } from '../lib/api'

/** Whether Claude is set up; null until `ai:status` answers. Read fresh on each mount. */
export function useAiConfigured(): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    api.invoke('ai:status').then(
      (s) => live && setConfigured(!!s?.configured),
      () => live && setConfigured(false),
    )
    return () => {
      live = false
    }
  }, [])
  return configured
}
