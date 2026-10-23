import type { IpcRendererEvent } from 'electron'
import { CHANNELS, EVENTS, type Channel, type EventName, type CredOpsBridge } from '../shared/ipc'

/** The slice of ipcRenderer the bridge uses, so it can be tested without Electron. */
export interface BridgeIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): unknown
}

const knownChannels: readonly string[] = CHANNELS
const knownEvents: readonly string[] = EVENTS

export function createBridge(ipc: BridgeIpc): CredOpsBridge {
  return {
    invoke: ((channel: Channel, ...args: unknown[]) => {
      if (!knownChannels.includes(channel)) return Promise.reject(new Error(`unknown channel: ${String(channel)}`))
      return ipc.invoke(channel, ...args)
    }) as CredOpsBridge['invoke'],
    on: ((event: EventName, listener: (payload: unknown) => void) => {
      if (!knownEvents.includes(event)) throw new Error(`unknown event: ${String(event)}`)
      // Only the payload crosses over; the IpcRendererEvent (and its sender) stays here.
      const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload)
      ipc.on(event, wrapped)
      return () => {
        ipc.removeListener(event, wrapped)
      }
    }) as CredOpsBridge['on'],
  }
}
