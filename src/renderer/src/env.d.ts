import type { OpsDeckBridge } from '../../shared/ipc'

declare global {
  interface Window {
    opsdeck: OpsDeckBridge
  }
}

export {}
