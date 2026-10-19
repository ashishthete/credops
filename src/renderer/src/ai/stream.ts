import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { errorText } from '../ui/common'

export type AiStreamState = 'idle' | 'streaming' | 'done' | 'error' | 'cancelled'

export interface AiStream<T> {
  /** Runs `run` with a fresh request id; deltas for that id accumulate into `text`. Resolves undefined on a rejection. */
  start(run: (requestId: string) => Promise<T>): Promise<T | undefined>
  text: string
  state: AiStreamState
  /** The rejection's message (an AiError result is the caller's to read). */
  error: string | null
  /** Cancels the live request (`ai:cancel`) and keeps the text shown so far; later deltas are ignored. */
  stop(): void
}

const nextFrame = (fn: () => void): (() => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn)
    return () => cancelAnimationFrame(id)
  }
  const id = setTimeout(fn, 16)
  return () => clearTimeout(id)
}

/** Streams one AI request at a time; `onText` gets the whole text so far, once per animation frame. */
export function useAiStream<T>(opts: { onText?: (text: string) => void } = {}): AiStream<T> {
  const [text, setText] = useState('')
  const [state, setState] = useState<AiStreamState>('idle')
  const [error, setError] = useState<string | null>(null)
  const live = useRef<{ id: string; stopped: boolean } | null>(null)
  const shown = useRef('')
  const pending = useRef('')
  const cancelFrame = useRef<(() => void) | null>(null)
  const onText = useRef(opts.onText)
  onText.current = opts.onText

  const flush = useCallback(() => {
    cancelFrame.current?.()
    cancelFrame.current = null
    if (pending.current === '') return
    shown.current += pending.current
    pending.current = ''
    setText(shown.current)
    onText.current?.(shown.current)
  }, [])

  const stop = useCallback(() => {
    const cur = live.current
    if (!cur || cur.stopped) return
    cur.stopped = true
    // Deltas not yet painted are dropped: the user keeps exactly what they saw.
    cancelFrame.current?.()
    cancelFrame.current = null
    pending.current = ''
    setState('cancelled')
    api.invoke('ai:cancel', cur.id).catch(() => undefined)
  }, [])

  useEffect(
    () =>
      api.on('ai:delta', ({ requestId, text: delta }) => {
        const cur = live.current
        if (!cur || cur.stopped || cur.id !== requestId) return
        pending.current += delta
        cancelFrame.current ??= nextFrame(flush)
      }),
    [flush],
  )

  // Unmounting mid-stream cancels the request.
  useEffect(() => stop, [stop])

  const start = useCallback(
    async (run: (requestId: string) => Promise<T>): Promise<T | undefined> => {
      stop()
      const me = { id: crypto.randomUUID(), stopped: false }
      live.current = me
      shown.current = ''
      pending.current = ''
      setText('')
      setError(null)
      setState('streaming')
      try {
        const out = await run(me.id)
        // Stopped or superseded: the reply is stale, so the caller never sees it (the user's edits win).
        if (live.current !== me || me.stopped) return undefined
        flush()
        me.stopped = true
        setState('done')
        return out
      } catch (e) {
        if (live.current === me && !me.stopped) {
          me.stopped = true
          setError(errorText(e))
          setState('error')
        }
        return undefined
      }
    },
    [flush, stop],
  )

  return { start, text, state, error, stop }
}
