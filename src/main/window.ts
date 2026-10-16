import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron'
import type { EventContract, EventName } from '../shared/ipc'
import type { LockReason } from '../shared/vault'

/** DevTools would let anyone at the keyboard read decrypted vault state, so packaged builds have none. */
export function windowOptions(preloadPath: string, isPackaged: boolean): BrowserWindowConstructorOptions {
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
      devTools: !isPackaged,
    },
  }
}

/**
 * Replaces Electron's default menu, whose View menu offers reload and DevTools in every build.
 * Edit roles stay so copy and paste keep working in text fields.
 */
export function appMenuTemplate(isPackaged: boolean, platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const sep: MenuItemConstructorOptions = { type: 'separator' }
  const app: MenuItemConstructorOptions =
    platform === 'darwin'
      ? {
          role: 'appMenu',
          submenu: [{ role: 'about' }, sep, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, sep, { role: 'quit' }],
        }
      : { label: 'File', submenu: [{ role: 'quit' }] }
  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [{ role: 'undo' }, { role: 'redo' }, sep, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
  }
  const view: MenuItemConstructorOptions[] = isPackaged
    ? []
    : [{ label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] }]
  return [app, edit, ...view, { role: 'windowMenu' }]
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

export interface PushTarget {
  isDestroyed(): boolean
  webContents: { send(channel: EventName, payload: EventContract[EventName]): void }
}

/** Sends one event to the window; a missing or destroyed window drops it. */
export function pushEvent<K extends EventName>(win: PushTarget | null, name: K, payload: EventContract[K]): void {
  if (win && !win.isDestroyed()) win.webContents.send(name, payload)
}

/** Pushes every vault lock (the reason only) to the window, so its auth gate comes up at once. */
export function forwardVaultLocks(vault: LockSource, window: () => PushTarget | null): () => void {
  return vault.onLock((reason) => pushEvent(window(), 'vault:locked', { reason }))
}
