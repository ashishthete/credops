import type { CredOpsBridge } from '../../../shared/ipc'
import { CodedError, codeOf, decodeIpcError } from '../../../shared/ipc-error'

const REMOTE_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/

/** Drops Electron's "Error invoking remote method '<channel>': Error: " wrapper and the code main put in front. */
export function cleanIpcErrorMessage(message: string): string {
  return decodeIpcError(message.replace(REMOTE_PREFIX, '')).message
}

/** The code main's error carried across IPC (`INVALID_STATE`, `confirm`, `VAULT_LOCKED`), when it had one. */
export const errorCode = (err: unknown): string | undefined => codeOf(err)

/** The error `api.invoke` rejects with: main's message as the user should read it, and its code when it had one. */
export function ipcError(raw: unknown): Error {
  const { code, message } = decodeIpcError((raw instanceof Error ? raw.message : String(raw)).replace(REMOTE_PREFIX, ''))
  return code === undefined ? new Error(message) : new CodedError(code, message)
}

// Resolved per call, so the bridge can be swapped (tests install a fresh mock per case).
export const api: CredOpsBridge = {
  invoke: async (channel, ...args) => {
    try {
      return await window.credops.invoke(channel, ...args)
    } catch (err) {
      throw ipcError(err)
    }
  },
  on: (event, listener) => window.credops.on(event, listener),
}
