import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { CHANNELS, type Handlers } from '../../shared/ipc'
import { redact } from '../security/redact'
import type { VALIDATORS } from './validators'

export function isTrustedSender(
  frameUrl: string,
  opts: { devServerUrl?: string; rendererFile: string },
): boolean {
  let url: URL
  try {
    url = new URL(frameUrl)
  } catch {
    return false
  }
  if (url.protocol === 'file:') {
    try {
      return resolve(fileURLToPath(url)) === resolve(opts.rendererFile)
    } catch {
      return false
    }
  }
  if (opts.devServerUrl) {
    try {
      return url.origin === new URL(opts.devServerUrl).origin
    } catch {
      return false
    }
  }
  return false
}

export function registerHandlers(
  ipc: Pick<IpcMain, 'handle'>,
  handlers: Handlers,
  trust: (frameUrl: string) => boolean,
  opts: { validators: typeof VALIDATORS; knownSecrets?: () => readonly string[] },
): void {
  for (const channel of CHANNELS) {
    const handler = handlers[channel] as (...args: unknown[]) => unknown
    const validate = opts.validators[channel] as (args: readonly unknown[]) => unknown[]
    ipc.handle(channel, async (event: IpcMainInvokeEvent, ...raw: unknown[]) => {
      if (!trust(event.senderFrame?.url ?? '')) throw new Error('untrusted sender')
      try {
        return await handler(...validate(raw))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(redact(message, opts.knownSecrets?.() ?? []))
      }
    })
  }
}
