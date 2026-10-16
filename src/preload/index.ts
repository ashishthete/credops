import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type Channel, type OpsDeckBridge } from '../shared/ipc'

const known: readonly string[] = CHANNELS

const bridge: OpsDeckBridge = {
  invoke: (channel: Channel, ...args: unknown[]) => {
    if (!known.includes(channel)) return Promise.reject(new Error(`unknown channel: ${String(channel)}`))
    return ipcRenderer.invoke(channel, ...args)
  },
}

contextBridge.exposeInMainWorld('opsdeck', bridge)
