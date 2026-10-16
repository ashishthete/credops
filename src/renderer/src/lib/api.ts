import type { OpsDeckBridge } from '../../../shared/ipc'

// Resolved per call, so the bridge can be swapped (tests install a fresh mock per case).
export const api: OpsDeckBridge = {
  invoke: (channel, ...args) => window.opsdeck.invoke(channel, ...args),
}
