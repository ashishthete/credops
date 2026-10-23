import type { CredOpsBridge } from '../../../shared/ipc'

const REMOTE_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/

/** Drops Electron's "Error invoking remote method '<channel>': Error: " wrapper. */
export function cleanIpcErrorMessage(message: string): string {
  return message.replace(REMOTE_PREFIX, '')
}

// Resolved per call, so the bridge can be swapped (tests install a fresh mock per case).
export const api: CredOpsBridge = {
  invoke: async (channel, ...args) => {
    try {
      return await window.credops.invoke(channel, ...args)
    } catch (err) {
      throw new Error(cleanIpcErrorMessage(err instanceof Error ? err.message : String(err)))
    }
  },
  on: (event, listener) => window.credops.on(event, listener),
}
