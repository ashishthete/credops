import type { CredOpsBridge } from '../../shared/ipc'

declare global {
  interface Window {
    credops: CredOpsBridge
  }
}

export {}
