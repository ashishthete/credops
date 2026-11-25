interface ErrorSource {
  on(event: 'uncaughtException', fn: (err: unknown) => void): unknown
  on(event: 'unhandledRejection', fn: (reason: unknown) => void): unknown
}

const text = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e))

/**
 * Writes an error nothing caught to main.log (redacted like every line) and lets the app go on: a stray rejection
 * in one feature must not take down open terminals, tunnels or a running deploy.
 */
export function logProcessErrors(proc: ErrorSource, log: { error(...args: unknown[]): void }): void {
  proc.on('uncaughtException', (err) => log.error(`uncaught exception: ${text(err)}`))
  proc.on('unhandledRejection', (reason) => log.error(`unhandled rejection: ${text(reason)}`))
}
