import type { BrowserWindowConstructorOptions } from 'electron'
import type { EventContract, EventName } from '../shared/ipc'
import type { LockReason } from '../shared/vault'

export function windowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    title: 'OpsDeck',
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  }
}

const withoutHash = (u: URL): string => {
  u.hash = ''
  return u.href
}

/**
 * True only when `target` is the document already loaded (hash routing aside).
 * Blocks dropped files, links and redirects from replacing the app.
 */
export function shouldAllowNavigation(current: string, target: string): boolean {
  try {
    return withoutHash(new URL(target)) === withoutHash(new URL(current))
  } catch {
    return false
  }
}

/** The dev server URL, honoured only for unpackaged (dev) runs. */
export function devRendererUrl(
  isPackaged: boolean,
  env: Record<string, string | undefined>,
): string | undefined {
  return isPackaged ? undefined : env['ELECTRON_RENDERER_URL'] || undefined
}

interface LockSource {
  onLock(fn: (reason: LockReason) => void): () => void
}

interface PushTarget {
  isDestroyed(): boolean
  webContents: { send(channel: EventName, payload: EventContract[EventName]): void }
}

/** Pushes every vault lock (the reason only) to the window, so its auth gate comes up at once. */
export function forwardVaultLocks(vault: LockSource, window: () => PushTarget | null): () => void {
  return vault.onLock((reason) => {
    const win = window()
    if (win && !win.isDestroyed()) win.webContents.send('vault:locked', { reason })
  })
}
