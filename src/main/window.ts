import type { BrowserWindowConstructorOptions } from 'electron'

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
