/**
 * Runs one step of a teardown that already failed once: the first error was logged, so this one is
 * swallowed and the next step still runs. Each step that can leave something open gets its own call.
 */
export function quietly(fn: () => void): void {
  try {
    fn()
  } catch {
    // Best effort only.
  }
}
