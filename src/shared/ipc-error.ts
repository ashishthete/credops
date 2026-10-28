// Imported by the renderer: no node or electron imports.

/**
 * Electron's `ipcRenderer.invoke` rejects with the handler's message only, so an error's `code` is written in
 * front of the message as it leaves main (`registerHandlers`) and read back in the renderer (`api.invoke`),
 * which rebuilds the error with `.code` and the message as main wrote it.
 */

/** A plain error with a `code` the renderer can test instead of the message text. */
export class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CodedError'
  }
}

/** A code is an identifier: a typed error's (`INVALID_STATE`, `confirm`, `host-key-changed`) or Node's (`ENOENT`). */
const CODE = /^[A-Za-z][\w.-]{0,63}$/
const WIRE = /^\[code:([A-Za-z][\w.-]{0,63})\] /

/** The error's string `code`, when it has one that is an identifier. */
export function codeOf(err: unknown): string | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' && CODE.test(code) ? code : undefined
}

/** The message as it crosses IPC: `[code:<code>] <message>`, or the message alone without a code. */
export function encodeIpcError(code: string | undefined, message: string): string {
  return code !== undefined && CODE.test(code) ? `[code:${code}] ${message}` : message
}

/** Splits a message `encodeIpcError` wrote back into its code and the message; any other text is all message. */
export function decodeIpcError(text: string): { code?: string; message: string } {
  const m = WIRE.exec(text)
  return m ? { code: m[1], message: text.slice(m[0].length) } : { message: text }
}
