import { CHANNELS, type Handlers } from '../../src/shared/ipc'

/** A full Handlers set where every channel throws unless overridden. */
export function stubHandlers(over: Partial<Handlers> = {}): Handlers {
  const base = Object.fromEntries(
    CHANNELS.map((c) => [
      c,
      () => {
        throw new Error(`unstubbed channel ${c}`)
      },
    ]),
  )
  return { ...base, ...over } as Handlers
}
