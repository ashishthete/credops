import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { CHANNELS, type Handlers } from '../../shared/ipc'

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
): void {
  for (const channel of CHANNELS) {
    const handler = handlers[channel] as (...args: unknown[]) => unknown
    ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!trust(event.senderFrame?.url ?? '')) throw new Error('untrusted sender')
      return handler(...args)
    })
  }
}
