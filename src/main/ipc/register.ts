import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { CHANNELS, type Channel, type Handlers } from '../../shared/ipc'
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

const field = (o: unknown, key: string): unknown => (typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[key] : undefined)
const proofSecrets = (proof: unknown): unknown[] => [field(proof, 'password'), field(proof, 'pin')]

/**
 * The PINs, passwords and reverify proofs a call carries, read from the raw args (validation may be
 * what failed). Masked in that call's error text, on top of the global known secrets.
 */
const SECRET_ARGS: { [K in Channel]?: (args: readonly unknown[]) => unknown[] } = {
  'vault:setup': ([opts]) => [field(opts, 'password'), field(opts, 'pin')],
  'vault:unlock': ([password]) => [password],
  'vault:unlockPin': ([pin]) => [pin],
  'vault:changePassword': ([current, next]) => [current, next],
  'vault:setQuickUnlock': ([, proof]) => proofSecrets(proof),
  'vault:setPin': ([pin, proof]) => [pin, ...proofSecrets(proof)],
  'vault:setPassword': ([next, proof]) => [next, ...proofSecrets(proof)],
  'vault:removePassword': ([current]) => [current],
  'auth:changeAccount': ([proof]) => proofSecrets(proof),
  'auth:disconnect': ([proof]) => proofSecrets(proof),
}

function callSecrets(channel: Channel, raw: readonly unknown[]): string[] {
  return (SECRET_ARGS[channel]?.(raw) ?? []).filter((s): s is string => typeof s === 'string')
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
        throw new Error(redact(message, [...(opts.knownSecrets?.() ?? []), ...callSecrets(channel, raw)]))
      }
    })
  }
}
